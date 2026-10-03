/**
 * Types for `bin/web-auth-store.js`.
 *
 * The store itself is plain CommonJS because the launcher loads it before Bun
 * is resolved (see the module header); this declaration is what the TypeScript
 * half of omp-web — `proxy.ts`, `lib/web-auth.ts`, `/api/web-access` — reads.
 */

export type WebAuthSource = "environment" | "stored" | "none";

export interface WebAuthDigest {
  algorithm: "scrypt";
  salt: string;
  hash: string;
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
}

export interface WebAuthStatus {
  /** Whether requests currently need credentials. */
  enabled: boolean;
  /** Whether a password exists at all, stored or in the environment. */
  configured: boolean;
  /** Whether a usable digest exists in the credential file. */
  stored: boolean;
  source: WebAuthSource;
  /** `OMP_WEB_PASSWORD` is set and overrides the stored credential. */
  managedByEnvironment: boolean;
  /** The credential file exists but could not be parsed. */
  unreadable: boolean;
  /** Basic Auth username omp-web accepts. */
  username: string;
  updatedAt: string | null;
  file: string;
}

/**
 * `open` — no credentials required. `environment` / `stored` — credentials
 * required, from `OMP_WEB_PASSWORD` or the credential file. `unavailable` —
 * the credential is unusable and every request must be refused.
 */
export type WebAuthPolicy =
  | { mode: "open"; file: string }
  | { mode: "unavailable"; file: string }
  | { mode: "environment"; password: string; file: string }
  | { mode: "stored"; digest: WebAuthDigest; file: string };

export interface WebAuthStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** Path of the credential file. Not the account file — see `accountsFile`. */
  file?: string;
  /**
   * Path of `omp-web-accounts.json`. A separate option on purpose: the two files
   * have different schemas, and sharing one field would make `verifyCredential`
   * read two incompatible documents from the same path.
   */
  accountsFile?: string;
  /** scrypt cost overrides. Only tests pass this, to keep hashing cheap. */
  params?: Partial<Omit<WebAuthDigest, "algorithm" | "salt" | "hash">>;
  policy?: WebAuthPolicy;
  now?: number;
  /**
   * Der Benutzername, fuer den eine Sitzung oder ein Konto aufgeloest wird.
   *
   * `string | undefined`, nicht `unknown`, und das ist eine bewusste Entscheidung
   * gegen die alte Fassung. Damals stand hier `unknown`, damit der
   * Passwort-Store ein ungeprueftes Body-Feld durchreichen konnte. Seit
   * `lib/web-auth-session.ts` dasselbe Feld fuer etwas anderes benutzt — es
   * waehlt damit das Konto, dessen Digest den Sitzungsschluessel bildet —,
   * erzeugte die Doppelbelegung genau den Fehler, den eine Option mit zwei
   * Bedeutungen immer erzeugt: `WebAuthStoreOptions` war nicht mehr zu sich
   * selbst zuweisbar, und jeder Aufrufer brauchte einen Cast.
   *
   * Der Preis ist eine Pruefung an der Route, und die ist billig und ehrlich:
   * `setWebPassword` validiert ohnehin, und wer hier etwas anderes durchreichen
   * will, bekommt einen Compilerfehler statt eines `any` zur Laufzeit. Ein Feld,
   * das zwei Typen je nach Aufrufer haben darf, ist kein Flexibilitaetsgewinn,
   * sondern eine Stelle, an der der naechste Aufrufer die falsche Bedeutung
   * trifft.
   */
  username?: string;
}

export type RecoveryIssueResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

export type RecoveryConsumeResult =
  | { ok: true; status: WebAuthStatus }
  | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" }
  | { ok: false; reason: "invalid-code"; remainingAttempts: number }
  | { ok: false; reason: "invalid-password"; message: string };

export type WebAuthState =
  | { status: "missing"; config: null }
  | { status: "unreadable"; config: null }
  | { status: "ok"; config: Record<string, unknown> };

/**
 * Ein Konto aus `omp-web-accounts.json`, in der Form, in der es benutzt wird.
 *
 * `isAdmin` steht hier, wird aber **nie** gelesen: die Funktionen berechnen es
 * bei jedem Aufruf neu aus `isAdminUsername`. Es steht in der Liste, damit ein
 * Aufrufer nicht selbst rechnen muss.
 */
export interface WebAccount {
  username: string;
  password: WebAuthDigest;
  enabled: boolean;
  isAdmin: boolean;
  /** Absoluter Pfad des Home-Verzeichnisses, `/home/$username`. */
  home: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Das Ergebnis eines Konto-Listenlesens. `unreadable` ist kein leeres
 * Ergebnis: es heisst, die Datei existiert und ist kaputt, und ein Aufrufer, der
 * das wie "niemand angelegt" behandelt, zeigt eine leere Oberflaeche, in der ein
 * Tippfehler niemandem auffaellt.
 */
export interface WebAccountList {
  status: "missing" | "ok" | "unreadable";
  accounts: WebAccount[];
  file: string;
}

/** Ein Konto, wie es auf der Platte liegt — ohne die abgeleiteten Felder. */
export interface WebAccountEntry {
  username: string;
  password: WebAuthDigest;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export declare const ACCOUNT_NAME_MAX_LENGTH: number;
export declare const DEFAULT_WEB_ADMIN_USERNAMES: string[];
export declare const DEFAULT_WEB_AUTH_USERNAME: string;
export declare const MIN_PASSWORD_LENGTH: number;
export declare const RECOVERY_CODE_TTL_MS: number;
export declare const RECOVERY_MAX_ATTEMPTS: number;
export declare const WEB_ACCOUNTS_FILENAME: string;
export declare const WEB_AUTH_FILENAME: string;
export declare const WEB_AUTH_USERNAME: string;

export declare function createWebAccount(
  username: unknown,
  password: unknown,
  options?: WebAuthStoreOptions,
): WebAccount;
export declare function findWebAccount(
  username: unknown,
  options?: WebAuthStoreOptions,
): WebAccountEntry | null;
export declare function isAdminUsername(username: unknown, env?: NodeJS.ProcessEnv): boolean;
export declare function listWebAccounts(options?: WebAuthStoreOptions): WebAccountList;
export declare function readWebAccounts(options?: WebAuthStoreOptions): {
  status: "missing" | "ok" | "unreadable";
  accounts: WebAccountEntry[];
  file: string;
};
export declare function resolveAccountHome(username: string, env?: NodeJS.ProcessEnv): string;
export declare function resolveAdminUsernames(env?: NodeJS.ProcessEnv): string[];
export declare function resolveHomeRoot(env?: NodeJS.ProcessEnv): string;
export declare function resolveWebAccountsFile(env?: NodeJS.ProcessEnv): string;
export declare function setWebAccountEnabled(
  username: unknown,
  enabled: boolean,
  options?: WebAuthStoreOptions,
): WebAccount;
export declare function setWebAccountPassword(
  username: unknown,
  password: unknown,
  options?: WebAuthStoreOptions,
): WebAccount;
export declare function validateAccountName(username: unknown): string | null;

export declare function checkHomeRootWritable(env?: NodeJS.ProcessEnv):
  | { ok: true; root: string }
  | { ok: false; root: string; detail: string; remediation: string };
export declare function clearVerificationCache(): void;
export declare function clearWebPassword(options?: WebAuthStoreOptions): WebAuthStatus;
export declare function consumeRecoveryCode(
  code: unknown,
  password: unknown,
  options?: WebAuthStoreOptions,
): RecoveryConsumeResult;
export declare function createDigest(
  secret: string,
  params?: WebAuthStoreOptions["params"],
): WebAuthDigest;
export declare function getWebAuthStatus(options?: WebAuthStoreOptions): WebAuthStatus;
export declare function issueRecoveryCode(options?: WebAuthStoreOptions): RecoveryIssueResult;
export declare function normalizeRecoveryCode(code: unknown): string;
export declare function readWebAuthState(file?: string): WebAuthState;
export declare function resolveAgentDir(env?: NodeJS.ProcessEnv): string;
export declare function resolveWebAuthFile(env?: NodeJS.ProcessEnv): string;
export declare function resolveWebAuthPolicy(options?: WebAuthStoreOptions): WebAuthPolicy;
export declare function setWebPassword(password: unknown, options?: WebAuthStoreOptions): WebAuthStatus;
export declare function setWebPasswordEnabled(enabled: boolean, options?: WebAuthStoreOptions): WebAuthStatus;
export declare function setWebUsername(username: unknown, options?: WebAuthStoreOptions): WebAuthStatus;
export declare function validatePassword(password: unknown): string | null;
export declare function validateUsername(username: unknown): string | null;
export declare function verifyDigest(secret: unknown, digest: unknown): boolean;
export declare function verifyWebPassword(password: unknown, options?: WebAuthStoreOptions): boolean;
