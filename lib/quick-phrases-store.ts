import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { getUserHome, type WebIdentity } from "./request-identity";
import { resolveTenantAgentDir } from "./tenant-config";
import { normalizeQuickPhrases, type QuickPhrase } from "./quick-phrases";

/**
 * Die serverseitige Ablage der Quick Phrases, eine Datei pro Konto.
 *
 * ### Warum ueberhaupt eine Datei
 *
 * Bis hierher lagen die Phrasen im `localStorage` des Browsers. Das ist ein
 * Speicher *pro Browser, progamm, pro Benutzer des Betriebssystems* — auf einem
 * geteilten Rechner oder in einem zweiten Fenster mit privatem Zustand sieht
 * jeder eine andere Liste, und der Phrasensatz folgt dem Rechner statt dem
 * Konto. Ausserdem ist er beim Wechsel des Browsers weg, ohne dass der Nutzer
 * etwas getan haette.
 *
 * ### Warum `resolveTenantAgentDir` und nicht ein neues Verzeichnis
 *
 * `lib/tenant-config.ts` beantwortet genau die Frage "welcher Pfad gehoert zu
 * diesem bereits festgestellten Benutzer" und macht das an *einer* Stelle. Ein
 * zweites `getUserHome`-Variant fuer Web-Daten wuerde die Mandantengrenze
 * aufspalten — genau das, was diese Datei an einem anderen Ort verhindert.
 *
 * Der Dateiname traegt das `omp-web-`-Praefix wie `omp-web-trusted-projects.json`
 * in `lib/project-trust.ts`: die Datei liegt im Agent-Verzeichnis, gehoert aber
 * *nicht* omp. Der Prefix sagt das beim Lesen im Verzeichnis, ohne dass man den
 * Importgraphen aufmachen muss. Er ist kein omp-Konfigurationsformat und darf
 * dort nicht von omp gelesen oder ueberschrieben werden.
 *
 * ### Warum die Grenze trotzdem geprueft wird
 *
 * `resolveTenantAgentDir` ist die *Herleitung* des Pfades, nicht dessen
 * Abnahme. `isPathWithinRoots` fragt, ob der fertige Pfad tatsaechlich unter der
 * Home der Identitaet liegt — und das **vor** dem `mkdir`, wie in
 * `app/api/default-cwd/route.ts`. Ein Pfad, der erst erzeugt und dann geprueft
 * wird, hinterlaesst bei jeder verweigerten Anfrage eine Datei in fremder Home.
 */
const STORE_FILE = "omp-web-quick-phrases.json";

/**
 * Der Pfad der Phrasendatei einer Identitaet.
 *
 * Fuer einen Admin ist das der globale Agent-Pfad (Prozess = Admin, wie
 * ueberall), fuer einen Mandanten `$HOME/<name>/.omp/agent` mit dem Benutzernamen
 * im Pfad. Der Pfad enthaelt damit die Mandantengrenze.
 */
export function getQuickPhrasesPath(identity: WebIdentity): string {
  return join(resolveTenantAgentDir(identity), STORE_FILE);
}

/**
 * `true`, wenn der Pfad der Phrasendatei unterhalb der Konto-Home liegt.
 *
 * Fuer einen Admin ist die Home `/`, und die Antwort ist damit immer `true` —
 * das ist gewollt und dieselbe Entscheidung, die `getUserHome` fuer den Admin
 * trifft. Der Check ist die zweite Schicht darueber: er faengt einen Fall, den
 * die Herleitung nicht kennt, naemlich eine Identitaet, deren Name als
 * Pfadsegment taugt, deren `OMP_WEB_HOME_ROOT` aber auf ein fremdes Verzeichnis
 * zeigt.
 */
export function isQuickPhrasesPathAllowed(identity: WebIdentity, path: string): boolean {
  return isPathWithinRoots(path, new Set([getUserHome(identity)]));
}

/**
 * Die gespeicherte Liste, oder `null`, wenn es noch keine Datei gibt.
 *
 * `null` ist nicht "leere Liste". Eine leere Liste ist eine Entscheidung des
 * Nutzers, die gespeichert wurde; `null` heisst "dieses Konto hat nie
 * gelesen". Der Unterschied entscheidet, ob die Voreinstellungen gesaet werden
 * duerfen, und deshalb wird er bis nach oben durchgereicht statt hier zu einer
 * leeren Liste zusammengefallen.
 *
 * Unlesbarer Inhalt (kaputtes JSON, falscher Typ) gilt wie "keine Datei" fuer
 * die Form, aber nicht fuer den Inhalt: es wird `[]` mit `exists: true`
 * zurueckgegeben. Ein Seed auf einen zerstoerten Bestand wuerde Phrasen
 * ueberschreiben, die der Nutzer weder sehen noch verteidigen kann.
 */
export function readQuickPhrasesFile(identity: WebIdentity): { exists: boolean; phrases: QuickPhrase[] } {
  const path = getQuickPhrasesPath(identity);
  if (!existsSync(path)) return { exists: false, phrases: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list = typeof parsed === "object" && parsed !== null && "phrases" in parsed ? parsed.phrases : parsed;
    return { exists: true, phrases: normalizeQuickPhrases(list) };
  } catch {
    return { exists: true, phrases: [] };
  }
}

/**
 * Schreibt die Liste atomar und mit `0o600`.
 *
 * `writePrivateFileAtomicSync` legt eine Temp-Datei mit `wx` an und benennt sie
 * um; ein Absturz mitten im Schreiben hinterlaesst damit die alte Datei und
 * keine halbe. Das Verzeichnis wird vorher mit `0o700` erzeugt, wie beim
 * Anlegen des Kontos.
 *
 * Ungueltige Eintraege (leerer `text`) fallen vor dem Schreiben weg. Eine
 * sichtbare Zeile ohne Text bleibt bearbeitbar, erzeugt aber keinen Knopf.
 */
export function writeQuickPhrasesFile(identity: WebIdentity, phrases: unknown): QuickPhrase[] {
  const path = getQuickPhrasesPath(identity);
  const valid = normalizeQuickPhrases(phrases);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify({ phrases: valid }, null, 2) + "\n");
  return valid;
}