import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Mandanten-Isolation fuer das Terminal.
 *
 * Der naive Weg waere ein OS-Benutzer pro Konto (`useradd omp<name>`) plus
 * `sudoers`-Regel plus `runuser`. Gemessen am 2026-10-03 auf dem Host, auf dem
 * diese Datei entstanden ist, geht davon **kein** Schritt: `sudo -n true`
 * antwortet mit `a password is required`, `setpriv --reuid=...` mit
 * `setresuid failed: Operation not permitted`, und `useradd` zwar vorhanden,
 * aber ohne sudoers-Regel nicht aufrufbar. Wer es trotzdem baut, liefert Code,
 * der auf dieser Maschine nie gelaufen ist.
 *
 * Der Weg, der ohne Privilegien geht, ist eine User-Namespace ueber
 * `bubblewrap`. Sie braucht kein root und kein sudo, und die Grenze erzwingt
 * der Kernel, nicht dieser Code. Gemessen im selben Lauf:
 *
 * - fremdes Home:        `No such file or directory` (unsichtbar, nicht nur unlesbar)
 * - `/etc/shadow`:       `Permission denied`
 * - `/root`:             `No such file or directory`
 * - `sudo -n true`:      `no new privileges flag is set, prevents sudo from running as root`
 * - `su nobody`:         `Authentication token manipulation error`
 * - `uid=0` in der NS:  ist nicht Host-root, `touch /root/pwned` scheitert
 *
 * Zwei Dinge, die man hier nicht falsch machen darf, und die beide gemessen
 * worden sind, weil sie wie funktionierende Isolation aussehen und es nicht
 * sind:
 *
 * 1. **Die Verzeichnisse werden nicht erzeugt, sondern gemountet.** `--bind
 *    <home> /home/<name>` laesst `/home/<name>` nur innerhalb der Namespace
 *    existieren. Auf dem Host gibt es den Pfad nicht. Ein echtes Verzeichnis
 *    anzulegen und es dann zu verstecken waere schwaecher: es gaebe etwas zu
 *    sehen, das man nur nicht sieht.
 * 2. **`HOME` muss gesetzt sein.** Ohne `--setenv HOME` sieht die innere
 *    Shell weiter das Home des aufrufenden Users, und damit wird die falsche
 *    Datei isoliert. Die Trennung entsteht dadurch, dass andere Mandanten
 *    gar nicht gemountet sind — nicht durch angelegte Verzeichnisse.
 */

/** Warum eine Sandbox nicht gebaut werden konnte. Kein `null`-Fall im Erfolg. */
export type SandboxFailureReason =
  | "unsupported-platform"
  | "bwrap-missing"
  | "userns-disabled"
  | "no-home"
  | "bad-username"
  | "cwd-outside-home";

export interface SandboxFailure {
  ok: false;
  reason: SandboxFailureReason;
  detail: string;
  remediation: string;
}

export interface SandboxPlan {
  ok: true;
  /** Das volle argv, inklusive `bwrap` an Position 0. */
  argv: string[];
}

export type SandboxResult = SandboxPlan | SandboxFailure;

export interface SandboxOptions {
  /** Das Home des Mandanten. Muss existieren; wird als dessen `/home/<name>` gemountet. */
  home: string;
  /** Der Benutzername, wird als Verzeichnisname unter `/home` verwendet. */
  username: string;
  /** Der Befehl, der in der Sandbox laufen soll (typischerweise `[script, -qfc, …]`). */
  command: string[];
  /** Wo die Shell startet. Muss unter `home` liegen, sonst bindet es nichts. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const SANDBOX_HOME = "/home";

/**
 * `bwrap` einmal suchen. Bewusst gecacht: das ist ein `PATH`-Scan auf dem Weg
 * in jedes Terminal, und `which` pro Spawn waere messbarer Ballast.
 */
let bwrapPath: string | null | undefined;

function findBwrap(env: NodeJS.ProcessEnv): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  try {
    bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8", env }).trim() || null;
  } catch {
    bwrapPath = null;
  }
  return bwrapPath;
}

/**
 * Sind unprivilegierte User-Namespaces ueberhaupt erlaubt?
 *
 * `unshare -Ur` ist die ehrlichere Pruefung als ein sysctl: es fragt nicht,
 * ob ein Schalter auf 1 steht, sondern ob der Kernel einen Namespace fuer
 * diesen Prozess tatsaechlich aufspannt. Auf Distros mit
 * `unprivileged_userns_clone=0` sagt der Schalter nichts ueber die
 * Wirksamkeit, der Aufruf schon.
 */
export function canUseUserNamespaces(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    // `stdio: "ignore"` schluckt die Ausgabe, deshalb ist das Argument
    // zwingend: ohne `encoding` gibt `execFileSync` einen Buffer zurueck, und
    // ein Vergleich gegen `undefined` waere immer falsch — die Pruefung meldete
    // dann auf jedem Host `false`, obwohl der Namespace aufgeht.
    execFileSync("unshare", ["-Ur", "true"], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Das Ergebnis der Voraussetzungspruefung, als Union auf `ok`.
 *
 * Als flache Struktur mit `ok: boolean` musste der Aufrufer `preflight.bwrap!`
 * schreiben, obwohl im Erfolgszweig `null` unmöglich ist. Die Union macht das
 * Unmoegliche zum Compile-Fehler statt zum `!`, und im Fehlerzweig ist
 * `remediation` pflicht, statt `string | null` mit einem `??`-Fallback, der
 * still `null` werden kann.
 */
export type SandboxPreflight =
  | { ok: true; bwrap: string; userNamespaces: true; remediation: null }
  | { ok: false; bwrap: string | null; userNamespaces: boolean; remediation: string };

/**
 * Ist eine Sandbox auf diesem Host ueberhaupt moeglich?
 *
 * `ok: true` heisst "die Voraussetzungen sind da" und **nicht** "die Isolation
 * greift" — das ist derselbe Unterschied, an dem `checkIsolationPrerequisites`
 * im alten Isolationsstrang gescheitert ist: es hat drei Binaries gefunden und
 * daraus eine Freigabe gemacht, ohne den einzigen Aufruf zu pruefen, der die
 * Berechtigung wirklich verraet.
 */
export function checkSandboxPrerequisites(env: NodeJS.ProcessEnv = process.env): SandboxPreflight {
  if (process.platform === "win32") {
    return { ok: false, bwrap: null, userNamespaces: false, remediation: "Windows has no user namespaces; the sandbox is unavailable there." };
  }
  const bwrap = findBwrap(env);
  if (bwrap === null) {
    return {
      ok: false,
      bwrap: null,
      userNamespaces: false,
      remediation: "Install bubblewrap (Arch: `pacman -S bubblewrap`), or the terminal will run as the service user without isolation.",
    };
  }
  const userNamespaces = canUseUserNamespaces(env);
  if (!userNamespaces) {
    return {
      ok: false,
      bwrap,
      userNamespaces: false,
      remediation: "Unprivileged user namespaces are disabled on this kernel, so bubblewrap cannot sandbox the shell.",
    };
  }
  return { ok: true, bwrap, userNamespaces: true, remediation: null };
}

/**
 * Die Sandbox-Argumente fuer einen Mandanten.
 *
 * Die Reihenfolge hier ist die Vertrag: `--tmpfs /tmp` zuerst, damit kein
 * fremder Pfad durch das echte `/tmp` sichtbar wird, danach genau **ein**
 * `--bind` fuer das eigene Home. Ein zweites `--bind` auf ein fremdes Home
 * waere genau der Fehler, den diese Funktion verhindert, indem sie kein
 * Argument dafuer kennt.
 */
export function planSandboxSpawn(options: SandboxOptions): SandboxResult {
  const env = options.env ?? process.env;
  const preflight = checkSandboxPrerequisites(env);
  if (!preflight.ok) {
    // `detail` ist die Beobachtung, `remediation` die Handlung. Beide gleich
    // zu setzen hiesse: der Logeintrag wiederholt die Anleitung und der
    // Diagnose fehlt.
    if (process.platform === "win32") {
      return {
        ok: false,
        reason: "unsupported-platform",
        detail: "Windows has no user namespaces, so bubblewrap cannot sandbox the shell.",
        remediation: preflight.remediation,
      };
    }
    if (preflight.bwrap === null) {
      return {
        ok: false,
        reason: "bwrap-missing",
        detail: "bwrap was not found on PATH.",
        remediation: preflight.remediation,
      };
    }
    return {
      ok: false,
      reason: "userns-disabled",
      detail: "unshare -Ur true failed; the kernel refuses unprivileged user namespaces.",
      remediation: preflight.remediation,
    };
  }
  const bwrap = preflight.bwrap;
  if (typeof options.home !== "string" || options.home.trim().length === 0) {
    return {
      ok: false,
      reason: "no-home",
      detail: "No home directory was resolved for this account.",
      remediation: "Give the account a home under OMP_WEB_HOME_ROOT; a sandbox without a home would isolate the wrong files.",
    };
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(options.username)) {
    return {
      ok: false,
      reason: "bad-username",
      detail: `Refusing to build a sandbox path from an unusable username: ${options.username}`,
      remediation: "The account name must match /^[a-z_][a-z0-9_-]{0,31}$/.",
    };
  }
  // Ein cwd ausserhalb des Homes wurde vorher unveraendert durchgereicht, und
  // bwrap starte daran nicht: gemessen `bwrap: Can't chdir to /tmp/outside-cwd:
  // No such file or directory`. Das ist kein theoretischer Fall — die
  // `~/omp-cwd-*`-Vergaben (AGENTS.md) sind genau solche Pfade, und die Route
  // haette es nur spaeter als `[Process exited with code 1]` im SSE-Strom
  // erfahren. Eine Shell, die im falschen Verzeichnis aufgeht, ist schlechter
  // als eine, die gar nicht aufgeht: deshalb die Ablehnung mit Grund, nicht ein
  // stilles Zurueckfallen auf `/`.
  if (!isInsideHome(options.cwd, options.home)) {
    return {
      ok: false,
      reason: "cwd-outside-home",
      detail: `The working directory ${options.cwd} is outside the tenant's home ${options.home} and is not mounted into the sandbox.`,
      remediation: "Choose a working directory inside the account's home, or extend the sandbox to bind it deliberately.",
    };
  }

  // Nur Systemverzeichnisse readonly einbinden. Alles, was nicht in dieser
  // Liste steht, existiert in der Sandbox nicht — das ist der eigentliche
  // Hebel, und deshalb ist die Liste absichtlich kurz statt "alles readonly".
  const argv = [
    bwrap,
    "--unshare-user",
    "--unshare-pid",
    // Ohne das sieht die Shell die Prozesse des Dienstes und der anderen
    // Mandanten. Gemessen: ohne `--unshare-pid` ist `/proc` die des Hosts.
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  // Verzeichnisse, die es auf diesem Host nicht gibt, werden uebersprungen.
  // Der Kommentar behauptete das vorher, der Code band sie trotzdem: gemessen
  // bricht `bwrap --ro-bind /nonexistent /nonexistent` mit `Can't find source
  // path` ab und beendet den Spawn, statt das Verzeichnis zu ignorieren.
  for (const dir of ["/lib", "/lib64", "/sbin"]) {
    if (existsSync(dir)) argv.push("--ro-bind", dir, dir);
  }

  // Das Arbeitsverzeichnis muss auf den Namespace-Pfad umgeschrieben werden.
  // Der Host-Pfad existiert innerhalb der Sandbox nicht: gemessen
  // `bwrap: Can't chdir to /tmp/omp-sandbox-*/grace: No such file or
  // directory`, weil das Home dort als `/home/<name>` haengt.
  const sandboxedCwd = mapCwdIntoSandbox(options.cwd, options.home, options.username);
  argv.push(
    "--bind", options.home, `${SANDBOX_HOME}/${options.username}`,
    "--setenv", "HOME", `${SANDBOX_HOME}/${options.username}`,
    "--setenv", "USER", options.username,
    "--setenv", "LOGNAME", options.username,
    "--chdir", sandboxedCwd,
  );
  argv.push(...options.command);
  return { ok: true, argv };
}

/**
 * Liegt `cwd` im Home oder darunter?
 *
 * Der `home + "/"`-Test ist absichtlich: `startsWith(home)` allein wuerde
 * `/home/alice2` als Kind von `/home/alice` durchlassen und damit in ein fremdes
 * Verzeichnis chdir. Fuer den Aufrufer ist die Frage nur "darf ich das ueberhaupt
 * in die Sandbox geben", deshalb heisst das Nein hier immer `cwd-outside-home`.
 */
function isInsideHome(cwd: string, home: string): boolean {
  return cwd === home || cwd.startsWith(`${home}/`);
}

/**
 * Rechnet einen Host-Pfad in den Namespace um. Nur fuer Pfade, die
 * `isInsideHome` bestanden haben — der Aufrufer lehnt den Rest ab.
 */
function mapCwdIntoSandbox(cwd: string, home: string, username: string): string {
  const homeInSandbox = `${SANDBOX_HOME}/${username}`;
  if (cwd === home) return homeInSandbox;
  return `${homeInSandbox}/${cwd.slice(home.length + 1)}`;
}
