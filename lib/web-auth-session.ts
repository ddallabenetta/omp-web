import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { findWebAccount, resolveWebAuthPolicy, validateAccountName, type WebAuthStoreOptions } from "../bin/web-auth-store.js";
import { getExpectedUsername } from "./web-auth";

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
 *
 * The cookie carries the signed username. That is the whole point of the
 * change: a session is not "the server is unlocked" but "this person is logged
 * in", and `proxy.ts` needs the name to build the request identity. Signing it
 * is what keeps a cookie minted for alice from being accepted for bob — an
 * unsigned username field would be a header an attacker simply rewrites.
 */

export const SESSION_COOKIE_NAME = "omp_session";

/** Sessions last a working day. Re-login is cheap; a long-lived cookie is not. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Payload schema version, so an old cookie is rejected rather than misread. */
const SESSION_VERSION = "1";

/**
 * Per-process boot salt. The cookie carries no salt, so the only way an old
 * cookie survives a restart is if this salt stays put — which it cannot,
 * because randomBytes regenerates it on every cold start. Sessions minted by a
 * previous instance therefore stop verifying until the browser logs in again,
 * even though the credential itself did not change.
 *
 * The key is secret because the credential is secret, not because the salt is.
 * Rotating the password already invalidates sessions through the secret
 * itself; this salt is what kills cookies on a plain restart, so together they
 * bind a cookie to (username, password, process) and it cannot outlive the run
 * that minted it.
 */
const KEY_SALT = randomBytes(32).toString("base64url");

/** Exported so the expiry test can forge a correctly signed cookie. */
export const __testKeySalt = KEY_SALT;

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
 * All three modes therefore key on whatever identifies the credential uniquely
 * and changes with it — the environment value itself, or the stored digest's
 * `salt:hash` fingerprint. Either way a new password means a new key, so every
 * cookie signed by the old one stops verifying.
 *
 * `username` selects an account. That is what makes a per-account session
 * possible on an *unlocked* server, where there is no password to bind to at
 * all: without this branch the admin who created accounts from the settings
 * panel would find that none of them can sign in, because the server never
 * demanded a credential. The account's own digest is the right key — unique to
 * that account, and it rotates with the password.
 */
function resolveSessionSecret(options: WebAuthStoreOptions): string | null {
  const policy = resolveWebAuthPolicy(options);

  if (typeof options.username === "string" && options.username.length > 0) {
    const account = findWebAccount(options.username, options);
    if (account) return `account:${account.username}|${account.password.salt}:${account.password.hash}`;
  }

  const username = getExpectedUsername(options.env);
  if (policy.mode === "environment") return `${username}:${policy.password}`;
  if (policy.mode === "stored") return `${username}|stored:${policy.digest.salt}:${policy.digest.hash}`;
  // `open` with no account behind it has no credential to bind to, and
  // `unavailable` has no readable one. Either way there is nothing to sign.
  return null;
}

/**
 * The decoded username field, or `null` if the cookie is not shaped like one.
 *
 * Read *before* the signature check and therefore trusted for nothing. It only
 * decides which key to verify with: the name is an input to `resolveSessionSecret`
 * the same way a database row id is, and a name that resolves to no credential
 * simply produces no key, which fails the check. A cookie claiming to be
 * `steimerbyte` on a server that has no such account cannot get past this.
 *
 * It is decoded rather than taken from an option because the verifier does not
 * know who the cookie claims to be — the cookie is the only place that can say.
 */
function readCookieUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parts = value.split(".");
  if (parts.length !== 6) return null;
  if (!BASE64URL.test(parts[4])) return null;

  const username = Buffer.from(parts[4], "base64url").toString("utf8");
  if (validateAccountName(username) !== null && username !== getExpectedUsername()) return null;
  return username;
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

function buildSessionValue(secret: string, username: string): string {
  const issuedAt = Date.now();
  const payload = [
    SESSION_VERSION,
    encodeTimestamp(issuedAt),
    encodeTimestamp(issuedAt + SESSION_TTL_MS),
    randomBytes(NONCE_BYTES).toString("base64url"),
    Buffer.from(username, "utf8").toString("base64url"),
  ].join(".");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Mint a session cookie for the active credential, or `null` when the lock is
 * off and there is nothing to sign.
 *
 * `username` goes into the signed payload, not into the key. The key decides
 * *which credential* a cookie belongs to; the payload field is what
 * `readSessionCookie` hands back so `proxy.ts` knows who is logged in. Putting
 * the name in the key instead would make the cookie unverifiable for exactly
 * the person it was minted for.
 */
export function issueSessionCookie(options: WebAuthStoreOptions = {}): string | null {
  const secret = resolveSessionSecret(options);
  if (secret === null) return null;
  return buildSessionValue(secret, options.username ?? getExpectedUsername(options.env));
}

/**
 * Check a cookie against the active credential. Returns `false` — never throws
 * — for anything malformed, expired, or signed with a different password.
 */
export function verifySessionCookie(
  value: unknown,
  options: WebAuthStoreOptions = {},
): boolean {
  return readSessionCookie(value, options) !== null;
}

/**
 * Which account a session cookie belongs to, or `null` for anything malformed,
 * expired, or signed with a different credential.
 *
 * The returned name is *verified*, not decoded-and-hoped: the signature covers
 * the username field, so swapping alice's name into bob's cookie breaks the
 * signature rather than granting alice bob's session. That is the difference
 * between this and a plain field in the cookie, which is a header the client
 * owns.
 */
export function readSessionCookie(
  value: unknown,
  options: WebAuthStoreOptions = {},
): string | null {
  const username = readCookieUsername(value);
  if (username === null) return null;

  const [version, issuedAt, expiry, nonce, encodedUser, signature] = (value as string).split(".");
  if (version !== SESSION_VERSION) return null;
  if (!BASE64URL.test(issuedAt) || !BASE64URL.test(nonce) || !BASE64URL.test(signature)) {
    return null;
  }

  const expiresAt = decodeTimestamp(expiry);
  if (expiresAt === null || Date.now() >= expiresAt) return null;

  // The name from the cookie picks the key. It is untrusted input at this point
  // and is treated as such: it selects a *stored* credential or nothing, and the
  // signature below still has to match before the name is handed back.
  const secret = resolveSessionSecret({ ...options, username });
  if (secret === null) return null;

  const payload = `${version}.${issuedAt}.${expiry}.${nonce}.${encodedUser}`;
  const expected = Buffer.from(sign(payload, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and the signature comes off
  // the wire, so the lengths are compared before it is reached.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  return username;
}
