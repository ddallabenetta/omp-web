import { mkdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getUserHome, isAdminIdentity, type WebIdentity } from "./request-identity";

/**
 * Wo die omp-Konfiguration eines Kontos liegt.
 *
 * Das Modul enthaelt **keine** Identitaetslogik. Es beantwortet genau eine
 * Frage: welcher Pfad gehoert zu diesem bereits *festgestellten* Benutzer. Die
 * Feststellung selbst macht `lib/request-identity.ts`, und das bleibt so — wer
 * hier eine zweite `getUserHome`-Variante aufmacht, hat die Mandantengrenze an
 * zwei Stellen statt an einer.
 *
 * ### Warum der Admin beim globalen Verzeichnis bleibt
 *
 * Der Prozess laeuft ohne uid-Wechsel als ein Benutzer (siehe
 * `lib/write-access.ts`). `pi`, `omp` und `steimerbyte` sind genau die Konten,
 * die es vor dem Mandantenumbau bereits gab. Ihre Dateien — `models.yml`,
 * `config.yml`, `agent.db` — liegen im globalen Agent-Verzeichnis des
 * Prozesses. Ein Admin, der auf ein eigenes Verzeichnis umgestellt wuerde,
 * saehe seinen Provider-Key verschwinden, ohne dass irgendwo ein Fehler
 * auftaucht. Deshalb: Admin = Prozess = globales Verzeichnis, unveraendert.
 *
 * ### Warum ein Nicht-Admin `$HOME/.omp/agent` bekommt
 *
 * `getUserHome()` liefert fuer einen Nicht-Admin genau `/home/$name`, und die
 * Kontoverwaltung legt dieses Verzeichnis an. Der Pfad ist damit derselbe, den
 * `omp` fuer dieses Konto selbst waehlen wuerde: dieselbe Person, dieselbe
 * Konfiguration, ein Key-Store, keine Ueberraschung. Er liegt zudem in der
 * eigenen Home, die `lib/allowed-roots.ts` der Identitaet ohnehin gibt.
 *
 * Bewusst *nicht* unterhalb des globalen Agent-Verzeichnisses: ein gemeinsamer
 * Elternpfad mit Nutzernamen ist eine Einladung, ihn an einer Stelle doch
 * wieder zusammenzufassen, und die Konto-Wurzel traegt schon die Trennung.
 *
 * ### Was mit vorhandenen Daten passiert
 *
 * Nichts wandert, nichts wird kopiert. Ein Bestands-Provider liegt im globalen
 * `models.yml` und bleibt dort, weil sein Besitzer ein Admin ist und Admins
 * global bleiben. Ein **neues** Nicht-Admin-Konto bekommt bewusst einen leeren
 * Zustand: der globale `models.yml` zu kopieren hiesse, den API-Key des
 * Betreibers an den ersten angemeldeten Mandanten weiterzugeben — genau das
 * Kostenleck, das diese Trennung schliesst.
 */
export function resolveTenantAgentDir(identity: WebIdentity): string {
  if (isAdminIdentity(identity)) return getAgentDir();
  return join(getUserHome(identity), ".omp", "agent");
}

/**
 * Dasselbe Verzeichnis, nur garantiert vorhanden.
 *
 * `Settings.loadIsolated()` und `discoverAuthStorage()` legen weder das
 * Verzeichnis noch `agent.db` an; ohne dieses `mkdir` wuerde die erste Anfrage
 * eines frischen Kontos mit einem SQLite-Fehler enden statt mit einer leeren
 * Konfiguration. `0o700` wie beim Anlegen des Kontos.
 */
export function ensureTenantAgentDir(identity: WebIdentity): string {
  const agentDir = resolveTenantAgentDir(identity);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  return agentDir;
}
