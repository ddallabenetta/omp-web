import { join, resolve } from "node:path";
import { resolveHomeRoot, validateAccountName } from "../bin/web-auth-store.js";

/**
 * Wer steht hinter diesem Request?
 *
 * Beide Header werden ausschliesslich von `proxy.ts` gesetzt, und zwar dort, wo
 * die Anmeldedaten gerade verifiziert wurden. Es gibt dafuer keinen zweiten Weg:
 * keine Route liest den Namen aus dem Body, dem Query-String oder dem Pfad.
 *
 * Warum ueberhaupt ein Header und nicht ein Request-Parameter: bei
 * `app/api/files/[...path]/route.ts` kommt der Pfad aus der **URL**. Wer den
 * Pfad waehlt, waehlt damit auch, welcher Mandant er sein will — die Absicherung
 * darf nie aus dem Pfad selbst kommen, sonst ist jeder Mandant ein Einzeiler.
 * Ein Header, den nur `proxy.ts` nach dem Pruefen der Anmeldedaten setzt, ist
 * die einzige Form, in der die Identitaot nicht vom Aufrufer gewaehlt werden
 * kann.
 *
 * `proxy.ts` loescht eingehende Werte, bevor es seine eigenen setzt. Ohne das
 * waere `x-omp-admin: 1` ein Kopf, den jeder Client mitschickt.
 */

export const REQUEST_USER_HEADER = "x-omp-user";
export const REQUEST_ADMIN_HEADER = "x-omp-admin";

export interface WebIdentity {
  username: string;
  isAdmin: boolean;
}

/**
 * Die Identitaet eines Requests, oder `null`, wenn keine gesetzt ist.
 *
 * `null` heisst "niemand angemeldet" und ist **keine** Einladung, grosszuegig
 * zu sein. Ein Request ohne diesen Header kam entweder aus einem Client, der
 * `proxy.ts` umgangen hat, oder aus einer Route ausserhalb des Matchers; in
 * beiden Faellen ist die Antwort 403. Es gibt hier bewusst keinen Fallback auf
 * einen Default-Benutzer und keinen Fallback auf Admin.
 */
export function getRequestIdentity(headers: Headers): WebIdentity | null {
  const username = headers.get(REQUEST_USER_HEADER);
  if (typeof username !== "string") return null;

  const trimmed = username.trim();
  // Der Wert ist an dieser Stelle vom Server selbst gesetzt, wird aber wie
  // alles aus dem Netz als unvertraeuig behandelt: ein Name, der nicht als
  // Pfadsegment taugt, ist kein Name, sondern ein Fehlversuch.
  if (validateAccountName(trimmed) !== null) return null;

  return { username: trimmed, isAdmin: headers.get(REQUEST_ADMIN_HEADER) === "1" };
}

/** `true` nur fuer eine Identitaet, die als Admin gekennzeichnet wurde. */
export function isAdminIdentity(identity: WebIdentity | null): boolean {
  return identity?.isAdmin === true;
}

/**
 * Das Konto-Wurzelverzeichnis einer Identitaet.
 *
 * Fuer einen Admin ist das `/`, fuer alle anderen genau `/home/$username`.
 * Das ist die eine Stelle, an der "Admin darf alles" technisch aussieht, und es
 * ist gewollt: ein Admin-Passwort zu kompromittieren heisst, den Host zu
 * kompromittieren, weil der Prozess ohne uid-Wechsel als ein Benutzer laeuft.
 *
 * Kein `os.homedir()` fuer den Admin-Fall. Der Unterschied waere hier keiner
 * (die Read-Grenze ist fuer einen Admin ohnehin offen), aber der Name waere
 * dann falsch: das ist keine Home, das ist der Konto-Wurzelraum.
 *
 * `env` ist ein Parameter und nicht `process.env` direkt, damit ein Test oder
 * ein Aufrufer mit eigener Umgebung dieselbe Wurzel sieht, unter der die
 * Konten auch angelegt wurden. Ein stilles `/home` neben einem
 * `OMP_WEB_HOME_ROOT` waere ein Fehler, der nur in der Testumgebung sichtbar
 * ist und im Betrieb keiner.
 */
export function getUserHome(identity: WebIdentity, env: NodeJS.ProcessEnv = process.env): string {
  if (identity.isAdmin) return "/";
  return join(resolveHomeRoot(env), identity.username);
}

/**
 * Der absolute Pfad, den ein Benutzer als Arbeitsverzeichnis bekommen kann.
 *
 * Bewusst eine Funktion und kein Pfad-Set im `globalThis`: ein prozess-globales
 * Set heisst, dass ein Benutzer, dessen Home erlaubt wurde, die Rechte aller
 * anderen erbt. Wer hier etwas erweitert, erweitert es fuer den Prozess.
 * `resolve` haelt das Ergebnis absolut, auch wenn der Aufrufer relativ prueft.
 */
export function resolveUserRoot(identity: WebIdentity): string {
  return resolve(getUserHome(identity));
}
