import { NextResponse } from "next/server";
import { getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  getQuickPhrasesPath,
  isQuickPhrasesPathAllowed,
  readQuickPhrasesFile,
  writeQuickPhrasesFile,
} from "@/lib/quick-phrases-store";
export const dynamic = "force-dynamic";

// GET/PUT /api/quick-phrases — die Phrasenliste des angemeldeten Kontos.
//
// Bewusst nach dem Muster von `app/api/models-config/route.ts`, nicht als
// generischer Key-Value-Speicher: es gibt genau eine Liste, und ein Speicher,
// in den ein Client beliebig viel und beliebig wohin schreiben kann, waere eine
// neue Mandantengrenze statt einer geloesten.

/**
 * Die Identitaet, oder `null` — und `null` ist hier 403.
 *
 * Bewusst als eigene Funktion und nicht als Default-Parameter: ein
 * `resolveTenantAgentDir(identity = ...)`-Default waere die Mandantengrenze an
 * einer Stelle, die man beim Aufruf uebersieht. `null` heisst "niemand
 * angemeldet", und das einzige Ergebnis, das daraus folgen darf, ist Ablehnung.
 *
 * Zusätzlich wird der *abgeleitete* Pfad gegen die Konto-Home geprueft, bevor
 * irgendein Verzeichnis entsteht (`app/api/default-cwd/route.ts` macht das
 * genauso). `getUserHome` ist die Grenze; diese Zeile ist die zweite Schicht,
 * die faengt, dass `OMP_WEB_HOME_ROOT` auf ein fremdes Verzeichnis zeigt.
 */
function requireIdentity(req: Request): WebIdentity | null {
  const identity = getRequestIdentity(req.headers);
  if (identity === null) return null;
  return isQuickPhrasesPathAllowed(identity, getQuickPhrasesPath(identity)) ? identity : null;
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // `exists` entscheidet, ob der Client saeen darf. Eine existierende Datei mit
  // leerer Liste ist eine Entscheidung des Nutzers und wird nie ueberschrieben.
  const { exists, phrases } = readQuickPhrasesFile(identity);
  return NextResponse.json({ phrases, exists });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || !("phrases" in body)) {
      return NextResponse.json({ error: "quick phrases must be an object with a phrases array" }, { status: 400 });
    }
    const raw: unknown = body.phrases;
    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: "phrases must be an array" }, { status: 400 });
    }
    // Das Geschriebene wird zurueckgegeben, damit der Client die validierte
    // Liste sieht und nicht seine eigene, noch ungepruefte.
    return NextResponse.json({ phrases: writeQuickPhrasesFile(identity, raw), exists: true });
  } catch {
    return NextResponse.json({ error: "Unable to save quick phrases" }, { status: 500 });
  }
}