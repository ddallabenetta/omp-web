import { createHash, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import {
  DEFAULT_WEB_AUTH_USERNAME,
  readWebAuthState,
  resolveWebAuthFile,
  resolveWebAuthPolicy,
  verifyWebPassword,
  type WebAuthStoreOptions,
} from "../bin/web-auth-store.js";

declare global {
  // The cached username plus the file mtime that produced it. A settings-panel
  // write invalidates the cache by changing the mtime — no extra invalidation
  // hook needed, and per-request `getExpectedUsername` calls stay cheap.
  var __ompWebAuthUsernameCache: { fileMtimeMs: number; username: string } | undefined;
}

/**
 * Resolve the Basic Auth username omp-web accepts, defaulting to `omp`.
 *
 * Lookups happen in this order:
 *   1. The `username` field of the credential file at `OMP_WEB_AUTH_FILE` (or
 *      the default location under the agent directory). A missing or empty
 *      value falls through to the next step rather than overriding the default.
 *   2. `OMP_WEB_USERNAME` from the environment, trimmed.
 *   3. The hard-coded default `omp`.
 *
 * Caching is mtime-keyed on `globalThis.__ompWebAuthUsernameCache`, and the
 * cache is only written when the credential file itself carries a `username`
 * field. The env-only path never caches: the env is the only input that can
 * change between calls in a long-running process (operator sets
 * `OMP_WEB_USERNAME`, a test mutates it), so any cache there would be a
 * foot-gun.
 */
export function getExpectedUsername(env = process.env): string {
  const file = resolveWebAuthFile(env);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // Missing or unreadable file: re-resolve every time. The env-only path
    // does not benefit from caching because the env can move underneath us.
    return resolveUsernameFromEnv(env);
  }

  const cached = globalThis.__ompWebAuthUsernameCache;
  if (cached && cached.fileMtimeMs === mtimeMs) {
    return cached.username;
  }

  const state = readWebAuthState(file);
  if (state.status === "ok" && typeof state.config.username === "string") {
    const trimmed = state.config.username.trim();
    if (trimmed.length > 0) {
      globalThis.__ompWebAuthUsernameCache = { fileMtimeMs: mtimeMs, username: trimmed };
      return trimmed;
    }
  }

  return resolveUsernameFromEnv(env);
}

function resolveUsernameFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.OMP_WEB_USERNAME;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return DEFAULT_WEB_AUTH_USERNAME;
}

/**
 * Constant form of `getExpectedUsername()` for callers that need a value at
 * module scope (settings UI copy, `proxy.ts` headers, tests). The whole repo
 * imports this name as a constant, so the export stays a string and just
 * snapshots whatever the resolver said at module load.
 *
 * NB: `OMP_WEB_AUTH_USERNAME` is a module-load snapshot. Runtime checks
 * (every request through `proxy.ts` and `lib/web-auth-session.ts`) call
 * `getExpectedUsername()` instead, so a settings-panel change takes effect on
 * the next request even though this constant is frozen.
 */
export const OMP_WEB_AUTH_USERNAME = getExpectedUsername();

/**
 * Outcome of checking one request's credentials.
 *
 * `unavailable` is not a failed login: it means the lock is on but its
 * credential cannot be read, so the request is refused rather than waved
 * through. See `resolveWebAuthPolicy` in `bin/web-auth-store.js`.
 */
export type WebAuthDecision = "allow" | "unauthorized" | "unavailable";

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.OMP_WEB_PASSWORD,
): password is string {
  return typeof password === "string" && password.length > 0;
}

/** Decode a `Basic` header, rejecting anything that is not exactly one canonical encoding. */
export function parseBasicCredentials(
  authorization: string | null,
): { username: string; password: string } | null {
  if (!authorization) return null;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return null;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return null;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return null;

  return {
    username: credentials.slice(0, separator),
    password: credentials.slice(separator + 1),
  };
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.OMP_WEB_PASSWORD,
): boolean {
  if (!isWebPasswordEnabled(password)) return false;

  const credentials = parseBasicCredentials(authorization);
  if (!credentials) return false;

  const usernameMatches = secretsEqual(credentials.username, OMP_WEB_AUTH_USERNAME);
  const passwordMatches = secretsEqual(credentials.password, password);
  return usernameMatches && passwordMatches;
}

/**
 * Authorize one request against whichever credential is in force — the
 * `OMP_WEB_PASSWORD` environment variable, or the hashed credential written by
 * the settings panel and `omp-web --authenticated`.
 */
export function authorizeWebRequest(
  authorization: string | null,
  options: WebAuthStoreOptions = {},
): WebAuthDecision {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode === "open") return "allow";
  if (policy.mode === "unavailable") return "unavailable";

  const credentials = parseBasicCredentials(authorization);
  if (!credentials || !secretsEqual(credentials.username, OMP_WEB_AUTH_USERNAME)) {
    return "unauthorized";
  }
  return verifyWebPassword(credentials.password, { ...options, policy }) ? "allow" : "unauthorized";
}
