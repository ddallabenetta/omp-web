"use strict";

/**
 * Credential store for omp-web's password lock.
 *
 * The password protects a server that can run a high-privilege agent, so it is
 * never written to disk in a recoverable form: the file keeps a `scrypt` digest
 * plus the salt and cost parameters that produced it, and verification recomputes
 * the digest. Recovery codes are stored the same way.
 *
 * This module lives in `bin/` rather than `lib/` on purpose. Both halves of
 * omp-web need it — the launcher (`bin/omp-web.js`, plain Node CommonJS, before
 * Bun is even resolved) and the server (`proxy.ts` and the `/api/web-access`
 * routes) — and only `bin/` is part of the published npm `files` list. It
 * therefore stays dependency-free CommonJS that both runtimes can load.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { homedir } = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { basename, dirname, join, resolve } = require("node:path");

/** Default Basic Auth username omp-web accepts. The password is the only secret. */
const DEFAULT_WEB_AUTH_USERNAME = "omp";

/** Credential filename, kept next to the agent configuration. */
const WEB_AUTH_FILENAME = "omp-web-auth.json";

/**
 * Backwards-compatible snapshot of the default username. Older callers that
 * want the built-in default without touching the file or the environment can
 * still import this name; runtime callers should use `getWebAuthStatus` or
 * `getExpectedUsername` in `lib/web-auth.ts` instead, which resolve the live
 * file first.
 */
const WEB_AUTH_USERNAME = DEFAULT_WEB_AUTH_USERNAME;

/** Current on-disk schema version. */
const WEB_AUTH_VERSION = 1;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

/**
 * scrypt cost. `cost` (N) 16384 with `blockSize` (r) 8 needs 16 MiB and lands
 * around 50 ms — expensive enough to make an intercepted digest impractical to
 * crack, cheap enough that a cold request pays it once (see `verifyWebPassword`,
 * which caches successful verifications).
 */
const SCRYPT_PARAMS = { algorithm: "scrypt", cost: 16384, blockSize: 8, parallelization: 1, keyLength: 64 };

/** Upper bounds applied to *stored* parameters, so a corrupt file cannot ask for gigabytes. */
const MAX_SCRYPT_COST = 1 << 20;
const MAX_SCRYPT_BLOCK_SIZE = 32;
const MAX_SCRYPT_PARALLELIZATION = 8;
const MAX_SCRYPT_KEY_LENGTH = 128;

/** Recovery codes are short-lived, single-use, and rate-limited by attempt count. */
const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_REISSUE_INTERVAL_MS = 30 * 1000;
/** Crockford base32 minus the ambiguous letters, so a code can be read off a console. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = 3;
const RECOVERY_GROUP_LENGTH = 4;

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Namen der Konten, die mehr duerfen als ihr eigenes Verzeichnis.
 *
 * ABSICHT UND KOSTEN, NICHT VERSEHEN: ein Admin darf fremde Verzeichnisse
 * beschreiben, weil der Server ohnehin als ein Benutzer laeuft. Ein
 * kompromittiertes Admin-Passwort ist damit gleichbedeutend mit einer
 * Kompromittierung des Hosts. Das ist eine bewusste Entscheidung des Betreibers
 * und keine Nachlaessigkeit — wer sie uebernimmt, tut es mit offenen Augen.
 *
 * Die Liste ist eine Eigenschaft der *Installation*, nicht der Anmeldedaten.
 * Deshalb steht sie hier als Konstante und nicht im JSON: eine Datei, die der
 * Webprozess selbst schreiben kann, darf keine Rechte vergeben, die er sonst
 * nur ueber eine Environment-Variable bekommt. `OMP_WEB_ADMINS` (kommagetrennt)
 * ueberschreibt sie, wenn eine andere Aufteilung noetig ist.
 */
const DEFAULT_WEB_ADMIN_USERNAMES = ["pi", "omp", "steimerbyte"];

/**
 * Unix-Konvention fuer Kontonamen.
 *
 * Strenger als `validateUsername` oben, und das ist Absicht: der Name wandert
 * als einzelnes Pfadsegment nach `/home/$user`. Zugelassen sind deshalb nur
 * Kleinbuchstaben, Ziffern, Unterstrich und Bindestrich, beginnend mit einem
 * Buchstaben oder Unterstrich. Damit ist ausgeschlossen, was `validateUsername`
 * fuer den Basic-Auth-Namen erlauben muss und hier nicht darf: Pfadtrenner,
 * `..`, fuehrende Bindestriche, Grossbuchstaben (Kollision auf case-insensitiven
 * Dateisystemen) und jedes Zeichen, das eine Shell umdeuten koennte.
 */
const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const ACCOUNT_NAME_MAX_LENGTH = 32;

/**
 * Resolve omp's agent directory without importing the SDK.
 *
 * `@oh-my-pi/pi-utils` ships TypeScript sources and `bun:` builtins, so the
 * launcher cannot load it, and `proxy.ts` must not pull the SDK into its bundle.
 * This mirrors omp's default layout: an explicit `PI_CODING_AGENT_DIR` wins,
 * otherwise `~/.omp/agent` with `PI_CONFIG_DIR` and the active profile applied.
 * Anything more exotic (an XDG migration) is addressed with `OMP_WEB_AUTH_FILE`.
 */
function resolveAgentDir(env = process.env) {
  if (env.PI_CODING_AGENT_DIR) return resolve(env.PI_CODING_AGENT_DIR);
  const configRoot = join(homedir(), env.PI_CONFIG_DIR || ".omp");
  const profile = normalizeProfileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  return profile ? join(configRoot, "profiles", profile, "agent") : join(configRoot, "agent");
}

/** Profile names omp would reject are ignored here rather than thrown on: the CLI reports them. */
function normalizeProfileName(profile) {
  const normalized = typeof profile === "string" ? profile.trim() : "";
  if (!normalized || normalized === "default") return undefined;
  return PROFILE_NAME_RE.test(normalized) && !normalized.endsWith(".") ? normalized : undefined;
}

/** Absolute path of the credential file. `OMP_WEB_AUTH_FILE` overrides the location entirely. */
function resolveWebAuthFile(env = process.env) {
  return env.OMP_WEB_AUTH_FILE
    ? resolve(env.OMP_WEB_AUTH_FILE)
    : join(resolveAgentDir(env), WEB_AUTH_FILENAME);
}

/**
 * Kontoverzeichnis, als eigene Datei neben der Credential-Datei.
 *
 * Warum nicht in `omp-web-auth.json` mitlesen und -schreiben:
 *
 *  1. Das bestehende Schema ist Version 1 und traegt genau *ein* Konto. Eine
 *     Nutzerliste darin waere ein Versionssprung, und eine laufende Installation
 *     darf durch dieses Feature nicht kaputtgehen — sie muss beim Lesen
 *     unveraendert funktionieren. Eine zweite Datei laesst die alte unberuehrt.
 *  2. Die beiden Dateien haben verschiedene Lebensdauern. Die Credential-Datei
 *     wird bei jeder Passwortrotation geschrieben; das Kontoverzeichnis nur
 *     beim Anlegen eines Kontos. Vermischt man beides, dreht jede
 *     Passwortrotation eine Datei, die es nicht betrifft.
 *  3. Die Credential-Datei gehoert dem Prozessbenutzer und ist der *eine*
 *     Zugang, mit dem man in die Admin-Oberflaeche kommt. Wer in derselben
 *     Datei Konten anlegen kann, kann sich sonst selbst Admin schreiben.
 *
 * `OMP_WEB_ACCOUNTS_FILE` ueberschreibt den Ort, wie bei der Credential-Datei.
 */
const WEB_ACCOUNTS_FILENAME = "omp-web-accounts.json";
const WEB_ACCOUNTS_VERSION = 1;

function resolveWebAccountsFile(env = process.env) {
  return env.OMP_WEB_ACCOUNTS_FILE
    ? resolve(env.OMP_WEB_ACCOUNTS_FILE)
    : join(resolveAgentDir(env), WEB_ACCOUNTS_FILENAME);
}

/**
 * Wurzelverzeichnis, unter dem jedes Konto sein Home bekommt.
 *
 * Fest auf `/home` eingestellt waere eine Annahme ueber die Maschine; deshalb
 * ist es eine Konstante mit einem Override. Ein Konto wird **nie** ausserhalb
 * dieser Wurzel angelegt — `validateAccountName` schliesst Pfadtrenner aus, und
 * `join` haengt genau ein Segment an.
 */
function resolveHomeRoot(env = process.env) {
  const raw = env.OMP_WEB_HOME_ROOT;
  return typeof raw === "string" && raw.trim().length > 0 ? resolve(raw.trim()) : "/home";
}

/**
 * Das Home eines Kontos: genau ein Segment unterhalb der Home-Wurzel.
 *
 * Kein `statSync` und kein Umweg ueber ein vorhandenes Verzeichnis. `join`
 * normalisiert `..` zwar, aber die Absicherung ist `validateAccountName`, die
 * einen Namen mit Trennern gar nicht erst zulässt — eine zweite Pruefung, die
 * dasselbe tut, waere nur eine, die man beim Lesen fuer noetig haelt.
 */
function resolveAccountHome(username, env = process.env) {
  return join(resolveHomeRoot(env), username);
}

/**
 * Kann der Dienst unter der Home-Wurzel ueberhaupt Verzeichnisse anlegen?
 *
 * Ohne diese Pruefung endet jedes `createWebAccount` in einem nackten
 * `EACCES: permission denied, mkdir '/home/xy'`. Das ist gemessen worden
 * (2026-10-03, `/home` ist `root:root 0755`, der Dienst laeuft
 * unprivilegiert) und sagt dem Admin nichts: nicht, welcher Pfad falsch ist,
 * nicht, dass er ihn waehlen kann, und nicht, dass ein Home-Root unter `/`
 * grundsaetzlich nicht beschreibbar ist.
 *
 * Geprueft wird nicht der Zielordner selbst, sondern der **Elternteil**: der
 * muss existieren und fuer diesen Prozess beschreibbar sein. Fehlt er, ist das
 * die loesbare Variante; ist er da und trotzdem nicht beschreibbar, dann
 * braucht es `chown` oder einen root-Setup-Schritt, und genau das steht im
 * Remediation-Text.
 *
 * Bewusst kein `mkdir -p` hier: diese Funktion soll nichts anlegen. Eine
 * Kontoanlage, die nebenbei eine Wurzel erzeugt, waere eine Nebenwirkung mit
 * Rootrechten, die niemand bestellt hat.
 */
function checkHomeRootWritable(env = process.env) {
  const root = resolveHomeRoot(env);

  // Existiert die Wurzel schon, ist nur sie relevant. Die Eltern zu pruefen war
  // hier falsch: es wird nichts mehr erstellt, sondern nur noch in eine
  // vorhandene Wurzel hineingeschrieben — ein nicht beschreibbares Eltern
  // verhindert das nicht. Vorher bekam man bei einem existierenden, korrekt
  // berechtigten Root eine Ablehnung, die der Admin nicht beheben konnte, ohne
  // Rechte an einem Verzeichnis zu veraendern, das nie benutzt wird.
  if (existsSync(root)) {
    if (isWritableDirectory(root)) return { ok: true, root };
    return {
      ok: false,
      root,
      detail: `${root} exists but is not writable by the service user (uid ${process.getuid() ?? "?"}).`,
      remediation: `Point OMP_WEB_HOME_ROOT at a directory the service user can write, or have an administrator chown ${root} to it.`,
    };
  }

  const parent = dirname(root);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    return {
      ok: false,
      root,
      detail: `${parent} does not exist, so ${root} cannot be created.`,
      remediation: `Point OMP_WEB_HOME_ROOT at a path that already exists, or create ${parent} and give the service user write access to it.`,
    };
  }
  if (!parentStat.isDirectory()) {
    return {
      ok: false,
      root,
      detail: `${parent} is not a directory.`,
      remediation: `OMP_WEB_HOME_ROOT=${root} cannot work because its parent ${parent} is not a directory.`,
    };
  }
  // Writable = no sticky bit, and either we own it or a group we belong to or
  // the world may write. A sticky directory (like /tmp) is deliberately not
  // enough: the service could create a home there, but it could not then repair
  // or remove one that a previous run left behind.
  if (!isWritableDirectory(parent)) {
    return {
      ok: false,
      root,
      detail: `${parent} is not writable by the service user (uid ${process.getuid() ?? "?"}).`,
      remediation: `Set OMP_WEB_HOME_ROOT to a directory the service user can write, for example a path under its own home, or have an administrator chown ${parent} to it.`,
    };
  }
  return { ok: true, root };
}

function isWritableDirectory(dir) {
  try {
    const stat = statSync(dir);
    const uid = process.getuid?.();
    if (typeof uid === "number" && uid === 0) return true;
    if (typeof uid === "number" && uid === stat.uid) return true;
    if ((stat.mode & 0o1000) !== 0) return false; // sticky: not a service root
    // Gruppen-Schreibrecht: ein 0o770-Verzeichnis, das einer Gruppe gehoert, in
    // der der Dienst ist, ist genau so benutzbar wie eines in eigener Hand. Ohne
    // diesen Zweig wurde es als unbeschreibbar abgelehnt und der Admin musste
    // Rechte an einem brauchbaren Verzeichnis veraendern.
    if ((stat.mode & 0o020) !== 0) {
      const groups = process.getgroups?.() ?? [];
      if (groups.includes(stat.gid)) return true;
    }
    return (stat.mode & 0o002) !== 0;
  } catch {
    return false;
  }
}

/** Reject passwords that cannot protect anything. Returns an error message, or null when acceptable. */
function validatePassword(password) {
  if (typeof password !== "string") return "A password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  }
  if (password.trim().length === 0) return "The password cannot be only whitespace.";
  return null;
}

/**
 * Reject usernames that Basic Auth cannot carry or that would be ambiguous in
 * the credential file. Returns an error message, or null when acceptable.
 *
 * Whitespace-only is rejected outright rather than falling back to the default
 * — the caller just typed one and deserves to see what was actually written.
 * `setWebUsername` trims leading/trailing whitespace before validating so an
 * operator who copies a name with surrounding spaces still gets it accepted.
 */
function validateUsername(username) {
  if (typeof username !== "string") return "A username is required.";
  const trimmed = username.trim();
  if (trimmed.length === 0) return "A username is required.";
  if (trimmed.length > 256) return "The username must be at most 256 characters long.";
  if (/\s/.test(trimmed)) return "The username cannot contain whitespace.";
  return null;
}

/**
 * Konten-Namen, die als einzelnes Pfadsegment unter `/home` landen.
 *
 * Bewusst strenger als `validateUsername`: dort geht es nur darum, was Basic
 * Auth uebertragen kann, hier darum, was ein Verzeichnisname sein darf. Deshalb
 * kein Slash, kein `..`, kein fuehrender Bindestrich, keine Grossbuchstaben und
 * keine Maximallaenge ueber 32 Zeichen.
 */
function validateAccountName(username) {
  if (typeof username !== "string") return "A username is required.";
  const trimmed = username.trim();
  if (trimmed.length === 0) return "A username is required.";
  if (trimmed !== username) return "The username cannot start or end with a space.";
  if (trimmed.length > ACCOUNT_NAME_MAX_LENGTH) {
    return `The username must be at most ${ACCOUNT_NAME_MAX_LENGTH} characters long.`;
  }
  if (!ACCOUNT_NAME_PATTERN.test(trimmed)) {
    return "The username may only contain lowercase letters, digits, underscores and hyphens, and must start with a letter or an underscore.";
  }
  return null;
}

/**
 * Wer mehr darf als sein eigenes Verzeichnis.
 *
 * Siehe `DEFAULT_WEB_ADMIN_USERNAMES` fuer die Begruendung, warum das eine
 * Eigenschaft der Installation ist. `OMP_WEB_ADMINS` ueberschreibt die
 * Vorgabe; leerer Wert bedeutet "es gibt keine Admins" und NICHT "alle".
 */
function resolveAdminUsernames(env = process.env) {
  const raw = env.OMP_WEB_ADMINS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  }
  return DEFAULT_WEB_ADMIN_USERNAMES;
}

function isAdminUsername(username, env = process.env) {
  if (typeof username !== "string" || username.length === 0) return false;
  return resolveAdminUsernames(env).includes(username);
}

function scryptOptions(params) {
  // maxmem must cover 128 * N * r * p; node's 32 MiB default is below what the
  // upper bounds allow, so it is derived rather than left implicit.
  const needed = 128 * params.cost * params.blockSize * params.parallelization;
  return {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    maxmem: Math.max(needed * 2, 32 * 1024 * 1024),
  };
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** A digest read back from disk is untrusted input: shape and cost are both checked. */
function isUsableDigest(digest) {
  return Boolean(digest)
    && typeof digest === "object"
    && digest.algorithm === "scrypt"
    && typeof digest.salt === "string" && digest.salt.length > 0
    && typeof digest.hash === "string" && digest.hash.length > 0
    && isPowerOfTwo(digest.cost) && digest.cost <= MAX_SCRYPT_COST
    && Number.isInteger(digest.blockSize) && digest.blockSize >= 1 && digest.blockSize <= MAX_SCRYPT_BLOCK_SIZE
    && Number.isInteger(digest.parallelization) && digest.parallelization >= 1
    && digest.parallelization <= MAX_SCRYPT_PARALLELIZATION
    && Number.isInteger(digest.keyLength) && digest.keyLength >= 16 && digest.keyLength <= MAX_SCRYPT_KEY_LENGTH;
}

/** Derive a storable digest. The plaintext is used here and nowhere else. */
function createDigest(secret, params = SCRYPT_PARAMS) {
  const resolved = { ...SCRYPT_PARAMS, ...params, algorithm: "scrypt" };
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, resolved.keyLength, scryptOptions(resolved));
  return {
    ...resolved,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

/** Timing-safe digest comparison. Any malformed input verifies as `false`. */
function verifyDigest(secret, digest) {
  if (typeof secret !== "string" || !isUsableDigest(digest)) return false;
  try {
    const salt = Buffer.from(digest.salt, "base64");
    const expected = Buffer.from(digest.hash, "base64");
    if (salt.length === 0 || expected.length !== digest.keyLength) return false;
    const actual = scryptSync(secret, salt, digest.keyLength, scryptOptions(digest));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Stable, non-reversible identity of a digest, used to key the verification cache. */
function digestFingerprint(digest) {
  return createHash("sha256").update(`${digest.salt}:${digest.hash}`, "utf8").digest("base64");
}

/**
 * Read the credential file.
 *
 * The three outcomes are deliberately distinct: a missing file means "no lock
 * configured", but an unreadable or malformed one must never be mistaken for
 * that — `proxy.ts` refuses every request in the `unreadable` case rather than
 * silently unlocking a server whose credential it cannot parse.
 */
function readWebAuthState(file = resolveWebAuthFile()) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing", config: null };
    return { status: "unreadable", config: null };
  }

  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "unreadable", config: null };
    }
    return { status: "ok", config: parsed };
  } catch {
    return { status: "unreadable", config: null };
  }
}

/**
 * Replace the credential file atomically, never widening its permissions.
 *
 * `lib/atomic-file.ts` does the same for the server half; the launcher cannot
 * import TypeScript, so the few lines are repeated here rather than adding a
 * build step to `bin/`.
 */
function writeWebAuthConfig(config, file = resolveWebAuthFile()) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.${basename(file)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, file);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file was never created, or is already gone.
    }
    throw error;
  }
}

/**
 * The config to build the next write on top of.
 *
 * An unreadable file normally throws rather than being silently discarded — a
 * mutation that dropped a credential it could not parse would unlock the
 * server. `setWebPassword` is the deliberate exception (`replaceUnreadable`):
 * it writes a complete config, so nothing is lost, and it is the escape hatch
 * `omp-web --reset-password` needs when the file has been corrupted.
 */
function currentConfig(file, { replaceUnreadable = false } = {}) {
  const state = readWebAuthState(file);
  if (state.status === "unreadable") {
    if (replaceUnreadable) return { version: WEB_AUTH_VERSION };
    throw new Error(`The omp-web credential file at ${file} could not be read. Run \`omp-web --reset-password\` to replace it.`);
  }
  return state.config ?? { version: WEB_AUTH_VERSION };
}

function environmentPassword(env = process.env) {
  const password = env.OMP_WEB_PASSWORD;
  return typeof password === "string" && password.length > 0 ? password : null;
}

/**
 * What the lock currently is, from the server's point of view.
 *
 * `mode` drives every caller: `open` lets requests through, `environment` and
 * `stored` demand credentials, `unavailable` fails closed.
 */
function resolveWebAuthPolicy(options = {}) {
  const env = options.env ?? process.env;
  const file = options.file ?? resolveWebAuthFile(env);

  const fromEnvironment = environmentPassword(env);
  if (fromEnvironment) return { mode: "environment", password: fromEnvironment, file };

  const state = readWebAuthState(file);
  if (state.status === "missing") return { mode: "open", file };
  if (state.status === "unreadable") return { mode: "unavailable", file };

  const config = state.config;
  if (config.enabled !== true) return { mode: "open", file };
  if (!isUsableDigest(config.password)) {
    // Locked with no usable credential: nobody could authenticate, so refusing
    // is the only honest answer. `--reset-password` or `/recover` clears it.
    return { mode: "unavailable", file };
  }
  return { mode: "stored", digest: config.password, file };
}

/** Human-readable state for the settings UI and the launcher. */
function getWebAuthStatus(options = {}) {
  const env = options.env ?? process.env;
  const file = options.file ?? resolveWebAuthFile(env);
  const fromEnvironment = environmentPassword(env);
  const state = readWebAuthState(file);
  const config = state.config ?? {};
  const storedPassword = isUsableDigest(config.password);
  const storedUsernameRaw = typeof config.username === "string" ? config.username.trim() : "";
  const storedUsernameUsable = storedUsernameRaw.length > 0;

  return {
    enabled: Boolean(fromEnvironment) || (state.status === "ok" && config.enabled === true && storedPassword),
    configured: Boolean(fromEnvironment) || storedPassword,
    stored: storedPassword,
    source: fromEnvironment ? "environment" : storedPassword ? "stored" : "none",
    managedByEnvironment: Boolean(fromEnvironment),
    unreadable: state.status === "unreadable",
    // The file wins over the default: an old file without `username` reports
    // `omp` so existing deployments see the same value they always did, and
    // the settings panel can write a new value that sticks afterwards.
    username: storedUsernameUsable ? storedUsernameRaw : DEFAULT_WEB_AUTH_USERNAME,
    updatedAt: typeof config.updatedAt === "string" ? config.updatedAt : null,
    file,
  };
}

/**
 * Verification cache.
 *
 * `proxy.ts` runs on every request — including SSE reconnects and the sidebar's
 * running-session poll — and scrypt is deliberately slow. Only *successful*
 * verifications are cached, so the map is bounded by the number of real
 * credentials in play, and each entry is keyed by the digest that accepted it:
 * changing or clearing the password invalidates every entry that depended on it.
 */
const verificationCache = new Map();
const VERIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const VERIFICATION_CACHE_MAX_ENTRIES = 32;

function cacheKey(secret, fingerprint) {
  return createHash("sha256").update(`${fingerprint}:${secret}`, "utf8").digest("base64");
}

function readVerificationCache(key) {
  const entry = verificationCache.get(key);
  if (!entry) return false;
  if (entry <= Date.now()) {
    verificationCache.delete(key);
    return false;
  }
  return true;
}

function writeVerificationCache(key) {
  if (verificationCache.size >= VERIFICATION_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [existing, expiresAt] of verificationCache) {
      if (expiresAt <= now) verificationCache.delete(existing);
    }
    if (verificationCache.size >= VERIFICATION_CACHE_MAX_ENTRIES) {
      verificationCache.delete(verificationCache.keys().next().value);
    }
  }
  verificationCache.set(key, Date.now() + VERIFICATION_CACHE_TTL_MS);
}

/** Drop cached verifications. Called after any credential change in this process. */
function clearVerificationCache() {
  verificationCache.clear();
}

function constantTimeStringEqual(actual, expected) {
  // Hashing first keeps the comparison constant-time regardless of length.
  const actualHash = createHash("sha256").update(actual, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualHash, expectedHash);
}

/**
 * Check a candidate password against whichever credential is in force.
 *
 * Returns `false` when the lock is off — callers decide whether an unlocked
 * server should let the request through; this answers "are these credentials
 * valid", not "is this request allowed".
 */
function verifyWebPassword(password, options = {}) {
  if (typeof password !== "string" || password.length === 0) return false;
  const policy = options.policy ?? resolveWebAuthPolicy(options);

  if (policy.mode === "environment") {
    return constantTimeStringEqual(password, policy.password);
  }
  if (policy.mode !== "stored") return false;

  const key = cacheKey(password, digestFingerprint(policy.digest));
  if (readVerificationCache(key)) return true;
  if (!verifyDigest(password, policy.digest)) return false;
  writeVerificationCache(key);
  return true;
}

function timestamp() {
  return new Date().toISOString();
}

/**
 * Das Kontoverzeichnis lesen.
 *
 * Drei Ausgaenge, aus demselben Grund wie bei `readWebAuthState`: eine fehlende
 * Datei bedeutet "noch niemand angelegt", eine kaputte darf nicht so tun, als
 * gaebe es keine Konten — sonst wuerde ein Tippfehler in der Datei eine ganze
 * Mandantenliste unsichtbar machen.
 */
/**
 * Die Konten-Datei aus den Optionen.
 *
 * Absichtlich **nicht** `options.file`: das ist der Pfad der Credential-Datei
 * und gehoert `setWebPassword` und Freunden. Ein gemeinsames Feld hiesse, dass
 * ein Test, der sein Passwort in eine Temp-Datei schreibt, ungefragt auch die
 * Kontenliste dorthin umhaengt — und dass `verifyCredential` dieselbe Datei
 * zweimal mit zwei verschiedenen Schemata lesen wuerde.
 */
function resolveWebAccountsFileFor(options = {}) {
  const env = options.env ?? process.env;
  return options.accountsFile ?? resolveWebAccountsFile(env);
}

function readWebAccounts(options = {}) {
  const file = resolveWebAccountsFileFor(options);
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing", accounts: [], file };
    return { status: "unreadable", accounts: [], file };
  }

  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.users)) {
      return { status: "unreadable", accounts: [], file };
    }
    return { status: "ok", accounts: parsed.users, file };
  } catch {
    return { status: "unreadable", accounts: [], file };
  }
}

/** Wie `writeWebAuthConfig`: atomar, Rechte werden nie aufgeweicht. */
function writeWebAccounts(accounts, options = {}) {
  const file = resolveWebAccountsFileFor(options);
  writeWebAuthConfig({ version: WEB_ACCOUNTS_VERSION, users: accounts, updatedAt: timestamp() }, file);
  return file;
}

/** Ein Eintrag, der nicht den erwarteten Feldern entspricht, wird verworfen statt geraten. */
function normalizeAccountEntry(entry, env = process.env) {
  if (!entry || typeof entry !== "object") return null;
  if (validateAccountName(entry.username) !== null) return null;
  if (!isUsableDigest(entry.password)) return null;
  return {
    username: entry.username,
    password: entry.password,
    enabled: entry.enabled !== false,
    isAdmin: isAdminUsername(entry.username, env),
    home: resolveAccountHome(entry.username, env),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
  };
}

/**
 * Alle Konten, fuer die Admin-Oberflaeche und Login.
 *
 * `isAdmin` wird **immer** neu berechnet und nie aus der Datei uebernommen:
 * die Datei koennte von einem aelteren Stand stammen oder manipuliert sein, und
 * die Admin-Frage gehoert der Installation, nicht dem Datensatz. Deshalb steht
 * sie hier auch nicht beim Schreiben, sondern wird beim Lesen abgeleitet — ein
 * geschriebenes `isAdmin: true` fuer einen Nicht-Admin wird also stillschweigend
 * zu `false`.
 */
function listWebAccounts(options = {}) {
  const state = readWebAccounts(options);
  const accounts = state.accounts
    .map((entry) => normalizeAccountEntry(entry, options.env ?? process.env))
    .filter((entry) => entry !== null)
    .sort((a, b) => a.username.localeCompare(b.username));
  return { status: state.status, accounts, file: state.file };
}

/**
 * Ein Konto anlegen: Datensatz **und** Home-Verzeichnis.
 *
 * Das Verzeichnis entsteht hier und nur hier. Es gibt bewusst keinen
 * Registrierungsweg: wer sich anmelden kann, muss schon in dieser Liste stehen,
 * und wer in dieser Liste steht, hat ein Passwort vom Admin bekommen. Eine
 * Selbstbedienung, die sich ihr eigenes Verzeichnis anlegt, waere eine
 * Anmeldeschleife, die sich selbst Rechte gibt.
 *
 * Rechte `0o700`, Besitzer der Prozessbenutzer. Das ist eine echte Grenze
 * innerhalb des Hosts. Sie war lange die einzige — der Prozess selbst laeuft
 * weiterhin ohne uid-Wechsel (siehe `lib/web-auth.ts`). Die zweite ist die
 * Terminal-Shell, die seit `lib/sandbox.ts` in einer User-Namespace laeuft und
 * dieses Verzeichnis gar nicht sieht.
 */
function createWebAccount(username, password, options = {}) {
  const env = options.env ?? process.env;
  const file = resolveWebAccountsFileFor(options);
  const name = typeof username === "string" ? username.trim() : username;

  const invalidName = validateAccountName(name);
  if (invalidName) throw new Error(invalidName);
  const invalidPassword = validatePassword(password);
  if (invalidPassword) throw new Error(invalidPassword);

  const state = readWebAccounts(options);
  if (state.status === "unreadable") {
    throw new Error(`The omp-web account file at ${file} could not be read. Repair or remove it.`);
  }
  if (state.accounts.some((entry) => entry && entry.username === name)) {
    throw new Error(`The account ${name} already exists.`);
  }

  // Verzeichnis zuerst: existiert es schon, ist der Name vergeben, auch wenn
  // der Datensatz fehlt. Ohne diese Reihenfolge bekamme man ein Konto ohne
  // Home und waere es nicht mehr los.
  //
  // Die Vorabpruefung des Elternverzeichnisses steht davor, weil der
  // `mkdir` sonst mit einem nackten `EACCES` abbricht und damit die einzige
  // Stelle verschleiert, an der der Admin etwas aendern kann.
  const homeRoot = checkHomeRootWritable(env);
  if (!homeRoot.ok) {
    throw new Error(`Cannot create a home for this account: ${homeRoot.detail} ${homeRoot.remediation}`);
  }
  const home = resolveAccountHome(name, env);
  if (existsSync(home)) throw new Error(`${home} already exists.`);
  try {
    mkdirSync(home, { recursive: false, mode: 0o700 });
  } catch (error) {
    // Der Parent war beschreibbar, das Anlegen scheiterte trotzdem. Dann ist
    // es fast immer der Name (zu lang, vorhanden als Datei) — der Original-
    // Fehler sagt das genauer als jede eigene Formulierung hier.
    throw new Error(`Cannot create ${home}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const now = timestamp();
  const entry = {
    username: name,
    password: createDigest(password, options.params),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    writeWebAccounts([...state.accounts, entry], options);
  } catch (error) {
    // Kein halb angelegtes Konto: das Verzeichnis waere da, der Zugang nicht.
    rmdirSync(home);
    throw error;
  }
  clearVerificationCache();
  return normalizeAccountEntry(entry, env);
}

/** Konto deaktivieren oder reaktivieren. Das Verzeichnis bleibt unberuehrt. */
function setWebAccountEnabled(username, enabled, options = {}) {
  const env = options.env ?? process.env;
  const file = resolveWebAccountsFileFor(options);
  const name = typeof username === "string" ? username.trim() : username;
  const invalid = validateAccountName(name);
  if (invalid) throw new Error(invalid);

  const state = readWebAccounts(options);
  if (state.status === "unreadable") {
    throw new Error(`The omp-web account file at ${file} could not be read. Repair or remove it.`);
  }
  const index = state.accounts.findIndex((entry) => entry && entry.username === name);
  if (index === -1) throw new Error(`No such account: ${name}`);

  const next = [...state.accounts];
  next[index] = { ...next[index], enabled: Boolean(enabled), updatedAt: timestamp() };
  writeWebAccounts(next, options);
  clearVerificationCache();
  return normalizeAccountEntry(next[index], env);
}

/** Neues Passwort fuer ein bestehendes Konto. */
function setWebAccountPassword(username, password, options = {}) {
  const env = options.env ?? process.env;
  const file = resolveWebAccountsFileFor(options);
  const name = typeof username === "string" ? username.trim() : username;
  const invalidName = validateAccountName(name);
  if (invalidName) throw new Error(invalidName);
  const invalidPassword = validatePassword(password);
  if (invalidPassword) throw new Error(invalidPassword);

  const state = readWebAccounts(options);
  if (state.status === "unreadable") {
    throw new Error(`The omp-web account file at ${file} could not be read. Repair or remove it.`);
  }
  const index = state.accounts.findIndex((entry) => entry && entry.username === name);
  if (index === -1) throw new Error(`No such account: ${name}`);

  const next = [...state.accounts];
  next[index] = {
    ...next[index],
    password: createDigest(password, options.params),
    updatedAt: timestamp(),
  };
  writeWebAccounts(next, options);
  clearVerificationCache();
  return normalizeAccountEntry(next[index], env);
}

/**
 * Ein Konto anhand seiner Zugangsdaten finden.
 *
 * Liefert `null` bei falschem Namen, falschem Passwort und deaktiviertem Konto
 * — fuer den Anrufer ist das ein und derselbe Fall. `enabled` wird *vor* dem
 * scrypt geprueft, damit ein deaktiviertes Konto keine CPU-Zyklen kostet, und
 * trotzdem mit derselben Verzoegerung beantwortet wird wie ein falsches
 * Passwort (das regelt die Login-Route, die das hier aufruft).
 */
function findWebAccount(username, options = {}) {
  if (typeof username !== "string" || username.length === 0) return null;
  const state = readWebAccounts(options);
  if (state.status !== "ok") return null;

  const entry = state.accounts.find((candidate) => candidate && candidate.username === username);
  if (!entry || entry.enabled === false) return null;
  if (!isUsableDigest(entry.password)) return null;
  return entry;
}

/**
 * Store a new password and turn the lock on.
 *
 * Any pending recovery code is dropped: whoever set this password no longer
 * needs one, and a stale code must not outlive the credential it was minted for.
 *
 * A supplied `username` is written in the same atomic write, so callers can
 * rotate `(username, password)` together — the route that orchestrates a
 * "Save password" pass does exactly that, and `OMP_WEB_USERNAME` is *not*
 * preferred here because the file always wins once it has a value.
 */
function setWebPassword(password, options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  const invalid = validatePassword(password);
  if (invalid) throw new Error(invalid);

  const config = currentConfig(file, { replaceUnreadable: true });
  const nextUsername = options.username !== undefined
    ? normalizeStoredUsername(options.username)
    : (typeof config.username === "string" ? config.username : undefined);
  writeWebAuthConfig({
    ...config,
    version: WEB_AUTH_VERSION,
    enabled: true,
    username: nextUsername,
    password: createDigest(password, options.params),
    updatedAt: timestamp(),
    recovery: undefined,
  }, file);
  clearVerificationCache();
  return getWebAuthStatus({ ...options, file });
}

/**
 * Replace the stored username without touching the password digest.
 *
 * Validates and trims the supplied value, persists it next to the existing
 * digest, and clears the verification cache: the session cookie in
 * `lib/web-auth-session.ts` keys off the `(username, password)` pair, so an
 * unchanged cache would accept a cookie minted under the previous username and
 * hand the new operator a session that nobody legitimately owns.
 *
 * Throws on an invalid username so the API route can return a 400 with the
 * message instead of writing the file half-correct.
 */
function setWebUsername(username, options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  if (typeof username !== "string") throw new Error("A username is required.");
  const trimmed = username.trim();
  const invalid = validateUsername(trimmed);
  if (invalid) throw new Error(invalid);

  const config = currentConfig(file);
  writeWebAuthConfig({
    ...config,
    version: WEB_AUTH_VERSION,
    username: trimmed,
    updatedAt: timestamp(),
  }, file);
  clearVerificationCache();
  return getWebAuthStatus({ ...options, file });
}

/**
 * Trim a candidate username down to the stored form. Returns `undefined` for
 * an empty/whitespace-only input so the field is dropped from the next write
 * and `getWebAuthStatus` falls back to the default.
 */
function normalizeStoredUsername(username) {
  if (typeof username !== "string") return undefined;
  const trimmed = username.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Turn the lock on or off without touching the stored digest. */
function setWebPasswordEnabled(enabled, options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  const config = currentConfig(file);
  if (enabled && !isUsableDigest(config.password)) {
    throw new Error("Set a password before enabling password access.");
  }

  // `config.username` carries through; toggling enable/disable is not an
  // opportunity to lose the operator-chosen username.
  writeWebAuthConfig({ ...config, version: WEB_AUTH_VERSION, enabled: Boolean(enabled) }, file);
  clearVerificationCache();
  return getWebAuthStatus({ ...options, file });
}

/** Forget the password entirely, leaving the server unlocked. */
function clearWebPassword(options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  const config = currentConfig(file);
  writeWebAuthConfig({
    ...config,
    version: WEB_AUTH_VERSION,
    enabled: false,
    // Keep the stored username around: a future `setWebPassword` would not
    // otherwise know the operator's preferred value, and the field is small.
    password: undefined,
    recovery: undefined,
    updatedAt: timestamp(),
  }, file);
  clearVerificationCache();
  return getWebAuthStatus({ ...options, file });
}

function formatRecoveryCode(bytes) {
  let code = "";
  for (let index = 0; index < RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH; index += 1) {
    if (index > 0 && index % RECOVERY_GROUP_LENGTH === 0) code += "-";
    code += RECOVERY_ALPHABET[bytes[index] % RECOVERY_ALPHABET.length];
  }
  return code;
}

/**
 * Canonical form of a typed code: case and the Crockford look-alikes are
 * forgiven, so a code copied off a console cannot fail on `O` versus `0`.
 */
function normalizeRecoveryCode(code) {
  if (typeof code !== "string") return "";
  return code
    .toUpperCase()
    .replace(/[OQ]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V")
    .replace(/[^0-9A-Z]/g, "");
}

/**
 * Mint a one-time recovery code.
 *
 * The caller is expected to print it on the server's own console — the code is
 * the proof that whoever is resetting the password can see that console. It is
 * returned here, never persisted in the clear, and stored only as a digest.
 */
function issueRecoveryCode(options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  const now = options.now ?? Date.now();
  const config = currentConfig(file);
  const pending = config.recovery;

  if (pending && typeof pending.issuedAt === "number" && now - pending.issuedAt < RECOVERY_REISSUE_INTERVAL_MS) {
    return { ok: false, reason: "throttled", retryAfterMs: RECOVERY_REISSUE_INTERVAL_MS - (now - pending.issuedAt) };
  }

  // Rejection sampling would be overkill: the alphabet has 32 symbols and a
  // byte is reduced modulo 32, which is exact.
  const code = formatRecoveryCode(randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH));
  const expiresAt = now + RECOVERY_CODE_TTL_MS;
  writeWebAuthConfig({
    ...config,
    version: WEB_AUTH_VERSION,
    recovery: {
      ...createDigest(normalizeRecoveryCode(code), options.params),
      issuedAt: now,
      expiresAt,
      attempts: 0,
    },
  }, file);

  return { ok: true, code, expiresAt };
}

/**
 * Spend a recovery code and set a new password.
 *
 * Single-use: the code is cleared whether it succeeded, expired, or ran out of
 * attempts, so a wrong guess can never be retried indefinitely.
 */
function consumeRecoveryCode(code, password, options = {}) {
  const file = options.file ?? resolveWebAuthFile(options.env ?? process.env);
  const now = options.now ?? Date.now();
  const config = currentConfig(file);
  const pending = config.recovery;

  if (!pending || !isUsableDigest(pending)) return { ok: false, reason: "no-code" };
  if (typeof pending.expiresAt !== "number" || pending.expiresAt <= now) {
    writeWebAuthConfig({ ...config, recovery: undefined }, file);
    return { ok: false, reason: "expired" };
  }

  const attempts = Number.isInteger(pending.attempts) ? pending.attempts : 0;
  if (attempts >= RECOVERY_MAX_ATTEMPTS) {
    writeWebAuthConfig({ ...config, recovery: undefined }, file);
    return { ok: false, reason: "too-many-attempts" };
  }

  if (!verifyDigest(normalizeRecoveryCode(code), pending)) {
    const remaining = RECOVERY_MAX_ATTEMPTS - attempts - 1;
    writeWebAuthConfig({
      ...config,
      recovery: remaining > 0 ? { ...pending, attempts: attempts + 1 } : undefined,
    }, file);
    return { ok: false, reason: "invalid-code", remainingAttempts: Math.max(remaining, 0) };
  }

  // The password is validated only once the code is known good, so a caller
  // cannot use validation errors to probe whether a code was correct.
  const invalid = validatePassword(password);
  if (invalid) return { ok: false, reason: "invalid-password", message: invalid };

  return { ok: true, status: setWebPassword(password, { ...options, file }) };
}

module.exports = {
  ACCOUNT_NAME_MAX_LENGTH,
  DEFAULT_WEB_ADMIN_USERNAMES,
  DEFAULT_WEB_AUTH_USERNAME,
  MIN_PASSWORD_LENGTH,
  RECOVERY_CODE_TTL_MS,
  RECOVERY_MAX_ATTEMPTS,
  WEB_ACCOUNTS_FILENAME,
  WEB_AUTH_FILENAME,
  WEB_AUTH_USERNAME,
  checkHomeRootWritable,
  clearVerificationCache,
  clearWebPassword,
  consumeRecoveryCode,
  createDigest,
  createWebAccount,
  findWebAccount,
  getWebAuthStatus,
  isAdminUsername,
  issueRecoveryCode,
  listWebAccounts,
  normalizeRecoveryCode,
  readWebAccounts,
  readWebAuthState,
  resolveAccountHome,
  resolveAdminUsernames,
  resolveAgentDir,
  resolveHomeRoot,
  resolveWebAccountsFile,
  resolveWebAuthFile,
  resolveWebAuthPolicy,
  setWebAccountEnabled,
  setWebAccountPassword,
  setWebPassword,
  setWebPasswordEnabled,
  setWebUsername,
  validateAccountName,
  validatePassword,
  validateUsername,
  verifyDigest,
  verifyWebPassword,
};
