import { NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";
import { getRequestIdentity, isAdminIdentity, type WebIdentity } from "@/lib/request-identity";

/**
 * Wer darf diese Shell sehen und anfassen?
 *
 * Zwei Faelle, und beide sind 404 statt 403:
 *
 * - Keine Identitaet: 404. `proxy.ts` setzt den Header, aber eine Route, die
 *   ohne Identitaet laeuft, darf nicht sagen "du bist fremd" — sie darf nicht
 *   einmal verraten, dass es diese Shell gibt.
 * - Fremde Shell: ebenfalls 404, nicht 403. Der Unterschied waere ein
 *   Orakel: 403 bestaetigt, dass die Id zu einer Shell gehoert, und die Ids
 *   sind UUIDs, die ein Angreifer nicht raten, sondern aus einer fremden
 *   Seitenliste bekommen wuerde. 404 macht beide Faelle ununterscheidbar.
 *
 * Der Admin-Zweig steht hier und nicht im Manager, weil das die einzige
 * Stelle ist, an der die Ausnahme gemacht wird.
 */
export function authorizeTerminalAccess(
  id: string,
  identity: WebIdentity | null,
): { ok: true; identity: WebIdentity } | { ok: false; response: NextResponse } {
  if (!identity) {
    return { ok: false, response: NextResponse.json({ error: "Unknown terminal" }, { status: 404 }) };
  }
  if (isAdminIdentity(identity)) {
    return { ok: true, identity };
  }
  if (!getTerminalManager().isOwnedBy(id, identity.username)) {
    return { ok: false, response: NextResponse.json({ error: "Unknown terminal" }, { status: 404 }) };
  }
  return { ok: true, identity };
}

/** Identitaet eines Requests, oder eine fertige 404-Antwort. */
export function requireIdentity(
  headers: Headers,
): { ok: true; identity: WebIdentity } | { ok: false; response: NextResponse } {
  const identity = getRequestIdentity(headers);
  if (!identity) {
    return { ok: false, response: NextResponse.json({ error: "Unknown terminal" }, { status: 404 }) };
  }
  return { ok: true, identity };
}
