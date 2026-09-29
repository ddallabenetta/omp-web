import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolveWebAuthPolicy, type WebAuthStoreOptions } from "../bin/web-auth-store.js";

/**
 * Signed session cookies for the web lock.
 *
 * Basic Auth still works — curl, the reverse proxy, and every existing client
 * rely on it. This is the browser-friendly second door: `POST`
 * `/api/web-access/login` exchanges the password for an `httpOnly` cookie that
 * `proxy.ts` then accepts. There is no JWT and no dependency: the cookie is a
 * signed nonce with an expiry, and it carries nothing about the user.
 *
 * The signature is keyed on the active credential, which is what makes sessions
 * die with the password — see `resolveSessionSecret`.
 */

export const SESSION_COOKIE_NAME = "omp_session";

/** Sessions last a working day. Re-login is cheap; a long-lived cookie is not. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Payload schema version, so an old cookie is rejected rather than misread. */
const SESSION_VERSION = "1";

/**
 * Fixed salt. The derived key is secret because the *password* is secret, not
 * because the salt is: there is one credential per server, the key never leaves
 * the process, and a per-user salt would buy nothing.
 */
const KEY_SALT = "omp.web.session.v1";

/** scrypt cost for the session key, matching the credential store's own. */
const KEY_PARAMS = { N: 16_384, r: 8, p: 1, keyLength: 64 };

/** Nonce length in bytes. Long enough that two logins in the same ms differ. */
const NONCE_BYTES = 12;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

declare global {
  var __ompSessionKeyCache: Map<string, Buffer> | undefined;
}

/**
 * scrypt is deliberately slow (~50-100 ms at N=16384), and `proxy.ts` pays that
 * cost on every authenticated request. Memoizing the derived key on
 * `globalThis` — the pattern this repo already uses for the session registry,
 * the file-index cache, and the models cache — makes it a once-per-password
 * cost. `globalThis` rather than a module-level `Map` because it survives the
 * dev-server reload that would otherwise re-derive the key.
 */
function getSessionKeyCache(): Map<string, Buffer> {
  if (!globalThis.__ompSessionKeyCache) globalThis.__ompSessionKeyCache = new Map();
  return globalThis.__ompSessionKeyCache;
}

function deriveSessionKey(secret: string): Buffer {
  const cache = getSessionKeyCache();
  const cached = cache.get(secret);
  if (cached) return cached;

  const key = scryptSync(secret, KEY_SALT, KEY_PARAMS.keyLength, {
    N: KEY_PARAMS.N,
    r: KEY_PARAMS.r,
    p: KEY_PARAMS.p,
  });
  cache.set(secret, key);
  return key;
}

/**
 * The active credential, as a stable server-side secret.
 *
 * `OMP_WEB_PASSWORD` hands over the plaintext, but a stored credential does
 * not: the file holds a scrypt digest and omp-web cannot read a password back.
 * Both modes therefore key on whatever identifies the credential uniquely and
 * changes with it — the environment value itself, or the stored digest's
 * `salt:hash` fingerprint. Either way a new password means a new key, so every
 * cookie signed by the old one stops verifying.
 */
function resolveSessionSecret(options: WebAuthStoreOptions): string | null {
  const policy = resolveWebAuthPolicy(options);
  if (policy.mode === "environment") return policy.password;
  if (policy.mode === "stored") return `stored:${policy.digest.salt}:${policy.digest.hash}`;
  // `open` has no password to bind to, and `unavailable` has no readable one.
  return null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", deriveSessionKey(secret)).update(payload, "utf8").digest("base64url");
}

/** A timestamp rides in the cookie as base64url so the payload stays one token. */
function encodeTimestamp(value: number): string {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

/** A cookie read off the wire is untrusted: shape is checked before it is used. */
function decodeTimestamp(field: string): number | null {
  if (!BASE64URL.test(field)) return null;
  const decoded = Buffer.from(field, "base64url").toString("utf8");
  if (!/^\d+$/.test(decoded)) return null;
  const value = Number(decoded);
  return Number.isSafeInteger(value) ? value : null;
}

function buildSessionValue(secret: string): string {
  const issuedAt = Date.now();
  const payload = [
    SESSION_VERSION,
    encodeTimestamp(issuedAt),
    encodeTimestamp(issuedAt + SESSION_TTL_MS),
    randomBytes(NONCE_BYTES).toString("base64url"),
  ].join(".");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Mint a session cookie for the active credential, or `null` when the lock is
 * off and there is nothing to sign.
 */
export function issueSessionCookie(options: WebAuthStoreOptions = {}): string | null {
  const secret = resolveSessionSecret(options);
  return secret === null ? null : buildSessionValue(secret);
}

/**
 * Check a cookie against the active credential. Returns `false` — never throws
 * — for anything malformed, expired, or signed with a different password.
 */
export function verifySessionCookie(
  value: unknown,
  options: WebAuthStoreOptions = {},
): boolean {
  if (typeof value !== "string" || value.length === 0) return false;

  const parts = value.split(".");
  if (parts.length !== 5) return false;

  const [version, issuedAt, expiry, nonce, signature] = parts;
  if (version !== SESSION_VERSION) return false;
  if (!BASE64URL.test(issuedAt) || !BASE64URL.test(nonce) || !BASE64URL.test(signature)) {
    return false;
  }

  const expiresAt = decodeTimestamp(expiry);
  if (expiresAt === null || Date.now() >= expiresAt) return false;

  const secret = resolveSessionSecret(options);
  if (secret === null) return false;

  const expected = Buffer.from(sign(`${version}.${issuedAt}.${expiry}.${nonce}`, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and the signature comes off
  // the wire, so the lengths are compared before it is reached.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
