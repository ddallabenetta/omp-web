import { NextResponse } from "next/server";
import {
  createWebAccount,
  listWebAccounts,
  resolveHomeRoot,
  setWebAccountEnabled,
  setWebAccountPassword,
  validateAccountName,
  validatePassword,
} from "@/bin/web-auth-store.js";
import { hasJsonContentType } from "@/lib/request-security";
import { getRequestIdentity, isAdminIdentity } from "@/lib/request-identity";

/**
 * Kontenverwaltung, ausschliesslich fuer Admins.
 *
 * Warum hier und nicht in `/api/settings`: diese Route ist der einzige Ort, an
 * dem Rechte vergeben werden, und sie gehoert nicht in die allgemeine
 * Einstellungsverwaltung, die ein anderer Agent parallel umbaut. Sie haengt
 * sich stattdessen an `/api/web-access/*`, wo die Nachbarschaft stimmt — das
 * sind die anderen Zugangskontroll-Routen (`/login`, `/recovery`).
 *
 * Drei Regeln, die jede Aktion hier einhalten muss:
 *
 *  1. **Admin wird aus der Identitaet gelesen, nie aus einem Request-Feld.**
 *     `isAdmin` kommt aus dem Header, den `proxy.ts` nach dem Pruefen der
 *     Anmeldedaten gesetzt hat. Ein `body.isAdmin` waere eine Schaltflaeche, die
 *     jeder selbst umlegt.
 *  2. **Kein Klartext-Passwort in der Antwort.** Zurueck kommt der Eintrag mit
 *     dem scrypt-Digest, genau in dem Format, in dem er gespeichert liegt —
 *     sonst steht das Passwort im Terminal-Scrollback des Admins und danach in
 *     irgendeinem Log.
 *  3. **Kein Self-Service und keine Registrierungsroute.** Es gibt genau einen
 *     Weg, auf dem ein Konto entsteht, und der laeuft durch diese Datei. Wer sich
 *     anmelden kann, muss vorher hier eingetragen worden sein.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type AccountAction = "set-password" | "set-enabled";

/** Die Aktionen, die es gibt. Ein Lookup, keine Liste zum Durchiterieren. */
const ACCOUNT_ACTIONS: Record<string, AccountAction> = {
  "set-password": "set-password",
  "set-enabled": "set-enabled",
};

/**
 * `null` heisst hier **nicht angemeldet** und wird wie ein Nicht-Admin behandelt:
 * 403, nicht irgendein Default-Benutzer. Ein Request ohne den Header kam entweder
 * aus einem Client, der `proxy.ts` umgangen hat, oder aus einer Route ausserhalb
 * des Matchers — beides ist kein Grund, grosszuegiger zu werden.
 */
function requireAdmin(request: Request): NextResponse | null {
  if (isAdminIdentity(getRequestIdentity(request.headers))) return null;
  return NextResponse.json(
    { error: "Administrator access is required." },
    { status: 403, headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const list = listWebAccounts();
  if (list.status === "unreadable") {
    return NextResponse.json(
      { error: `The account file at ${list.file} could not be read. Repair or remove it.` },
      { status: 500, headers: NO_STORE },
    );
  }
  return NextResponse.json(
    {
      // `WebAccount` traegt den scrypt-Digest, nicht das Passwort. Der Store
      // kann das Klartext gar nicht liefern, es wurde beim Anlegen zu einem
      // Digest gehasht und danach nie gespeichert — deshalb steht hier kein
      // Filter, der Felder wegnimmt, sondern genau der Datensatz, der auch auf
      // der Platte liegt.
      accounts: list.accounts,
      homeRoot: resolveHomeRoot(),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json() as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  // Reihenfolge: erst der Name, dann das Passwort. `validateAccountName` ist die
  // Absicherung gegen `../etc` und `a/b` — es muss *vor* jedem `mkdir` laufen,
  // und `createWebAccount` prueft es ein zweites Mal, direkt bevor es das
  // Verzeichnis anlegt. Ein 400 hier darf kein Verzeichnis hinterlassen.
  if (typeof body.username !== "string" || body.username.trim() !== body.username) {
    return NextResponse.json(
      { error: "The username cannot start or end with a space." },
      { status: 400 },
    );
  }
  const invalidName = validateAccountName(body.username);
  if (invalidName) return NextResponse.json({ error: invalidName }, { status: 400 });

  if (typeof body.password !== "string") {
    return NextResponse.json({ error: "A password is required." }, { status: 400 });
  }
  const invalidPassword = validatePassword(body.password);
  if (invalidPassword) return NextResponse.json({ error: invalidPassword }, { status: 400 });

  try {
    return NextResponse.json(
      { account: createWebAccount(body.username, body.password) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}

export async function PATCH(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { action?: unknown; username?: unknown; password?: unknown; enabled?: unknown };
  try {
    body = await request.json() as { action?: unknown; username?: unknown; password?: unknown; enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? ACCOUNT_ACTIONS[body.action] : undefined;
  if (action === undefined) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  if (typeof body.username !== "string" || validateAccountName(body.username) !== null) {
    return NextResponse.json({ error: "A valid username is required." }, { status: 400 });
  }

  try {
    if (action === "set-enabled") {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "`enabled` must be true or false." }, { status: 400 });
      }
      return NextResponse.json(
        { account: setWebAccountEnabled(body.username, body.enabled) },
        { headers: NO_STORE },
      );
    }

    if (typeof body.password !== "string") {
      return NextResponse.json({ error: "A password is required." }, { status: 400 });
    }
    const invalidPassword = validatePassword(body.password);
    if (invalidPassword) return NextResponse.json({ error: invalidPassword }, { status: 400 });
    return NextResponse.json(
      { account: setWebAccountPassword(body.username, body.password) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
