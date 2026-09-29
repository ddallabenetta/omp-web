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
  file?: string;
  /** scrypt cost overrides. Only tests pass this, to keep hashing cheap. */
  params?: Partial<Omit<WebAuthDigest, "algorithm" | "salt" | "hash">>;
  policy?: WebAuthPolicy;
  now?: number;
  /**
   * Used by `setWebPassword` to atomically rotate the stored username in the
   * same write. `setWebUsername` and the read-side helpers ignore it.
   * `unknown` rather than `string` so the route handler can pass body fields
   * straight through without an intermediate cast.
   */
  username?: unknown;
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

export declare const DEFAULT_WEB_AUTH_USERNAME: string;
export declare const MIN_PASSWORD_LENGTH: number;
export declare const RECOVERY_CODE_TTL_MS: number;
export declare const RECOVERY_MAX_ATTEMPTS: number;
export declare const WEB_AUTH_FILENAME: string;
export declare const WEB_AUTH_USERNAME: string;

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
