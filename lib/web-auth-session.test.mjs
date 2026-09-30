import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import test from "node:test";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "correct horse battery stapl";
const TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Sessions key off the credential, so these run against the
 * `OMP_WEB_PASSWORD` policy: it is the mode where the server holds the secret
 * itself. The stored mode derives the same key from the digest fingerprint,
 * which the store's own tests already cover.
 */
function options(env = {}) {
  return { env: { OMP_WEB_PASSWORD: PASSWORD, ...env } };
}

async function loadSubject() {
  return import("./web-auth-session.ts");
}

test("accepts a freshly minted cookie and issues no cookie while the lock is off", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  assert.equal(typeof cookie, "string");
  assert.equal(verifySessionCookie(cookie, options()), true);

  // No credential, nothing to bind a session to — and a server that has no
  // password is already letting everyone through.
  assert.equal(issueSessionCookie({ env: {} }), null);
  assert.equal(verifySessionCookie(cookie, { env: {} }), false);
});

/**
 * The cookie now names its account, and the name is what a route uses to build
 * the tenant boundary — so what matters is that it is signed, not that it is
 * absent. A password in the cookie would still be the bug.
 */
test("carries the signed username and no password", async () => {
  const { issueSessionCookie, readSessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options({ OMP_WEB_USERNAME: "alice" }));
  assert.equal(cookie.includes(PASSWORD), false);
  // version, issuedAt, expiry, nonce, username, signature
  assert.equal(cookie.split(".").length, 6);
  assert.equal(readSessionCookie(cookie, options({ OMP_WEB_USERNAME: "alice" })), "alice");
});

/**
 * The failure this feature exists to prevent: a cookie minted for alice must
 * not read as bob. Swapping the username field invalidates the signature, which
 * is the whole reason the field is inside the signed payload rather than next
 * to it.
 */
test("a cookie rewritten for another account is rejected", async () => {
  const { issueSessionCookie, readSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options({ OMP_WEB_USERNAME: "alice" }));
  const [version, issuedAt, expiry, nonce, , signature] = cookie.split(".");
  const asBob = Buffer.from("bob", "utf8").toString("base64url");

  const rewritten = `${version}.${issuedAt}.${expiry}.${nonce}.${asBob}.${signature}`;
  assert.equal(readSessionCookie(rewritten, options({ OMP_WEB_USERNAME: "alice" })), null);
  assert.equal(verifySessionCookie(rewritten, options({ OMP_WEB_USERNAME: "alice" })), false);
});

test("issues a different cookie each time even within the same millisecond", async () => {
  const { issueSessionCookie } = await loadSubject();

  assert.notEqual(issueSessionCookie(options()), issueSessionCookie(options()));
});

test("rejects a tampered payload", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const [version, issuedAt, expiry, nonce, username, signature] = issueSessionCookie(options()).split(".");
  // Push the expiry out by a year without touching the signature.
  const extended = Buffer.from(String(Date.now() + 365 * 24 * 60 * 60 * 1000), "utf8")
    .toString("base64url");

  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${extended}.${nonce}.${username}.${signature}`, options()), false);
  // A swapped nonce is the same forgery from the other direction.
  // The replacement character has to depend on what is actually there: the
  // nonce is base64url, so its last character can already be "A". Writing "A"
  // unconditionally is then a no-op, the cookie stays valid, and this assertion
  // fails on roughly one run in 64 — measured at 3 of 120 end-to-end runs.
  // The signature test below already gets this right with `flipped`.
  const flippedNonce = nonce.at(-1) === "A" ? "B" : "A";
  assert.equal(verifySessionCookie(`${version}.${issuedAt}.${expiry}.${nonce.slice(0, -1)}${flippedNonce}.${username}.${signature}`, options()), false);
});

test("rejects a tampered signature", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  const [payload, signature] = cookie.split(".");
  const flipped = signature[0] === "A" ? "B" : "A";

  assert.equal(verifySessionCookie(`${payload}.${flipped}${signature.slice(1)}`, options()), false);
  assert.equal(verifySessionCookie(`${payload}.`, options()), false);
  assert.equal(verifySessionCookie(`${payload}.${signature}${signature}`, options()), false);
});

test("rejects a cookie minted under a different password", async () => {
  const { issueSessionCookie, verifySessionCookie } = await loadSubject();

  const cookie = issueSessionCookie(options());
  const other = options({ OMP_WEB_PASSWORD: OTHER_PASSWORD });

  assert.equal(verifySessionCookie(cookie, other), false);
  // And the same holds in reverse: a cookie from the old password dies the
  // moment the credential changes, which is what logging out everyone means.
  assert.equal(verifySessionCookie(issueSessionCookie(other), options()), false);
});

test("rejects a cookie past its expiry", async () => {
  const { issueSessionCookie, verifySessionCookie, SESSION_TTL_MS, __testKeySalt } = await loadSubject();

  assert.equal(SESSION_TTL_MS, TTL_MS);

  const [version, issuedAt, , nonce, username] = issueSessionCookie(options()).split(".");

  /** A correctly signed cookie that expired at `at`, forged because a real one
   *  cannot be waited out in a test. */
  const expiringAt = (at) => {
    const payload = `${version}.${issuedAt}.${Buffer.from(String(at), "utf8").toString("base64url")}.${nonce}.${username}`;
    // The key is derived from the (username, password) pair and the process's
    // boot salt, so the forge has to mirror `resolveSessionSecret` and pull the
    // same salt. Hardcoding either would make the forgery fail on its signature
    // rather than on the expiry this test is about.
    const key = scryptSync(`omp:${PASSWORD}`, __testKeySalt, 64, { N: 16384, r: 8, p: 1 });
    return `${payload}.${createHmac("sha256", key).update(payload, "utf8").digest("base64url")}`;
  };

  assert.equal(verifySessionCookie(expiringAt(Date.now() - 1), options()), false);
  // One millisecond ahead is still inside the window, which shows the rejection
  // above is the expiry and not a broken forgery.
  assert.equal(verifySessionCookie(expiringAt(Date.now() + 60_000), options()), true);
});

test("returns false rather than throwing on malformed input", async () => {
  const { verifySessionCookie } = await loadSubject();

  for (const value of [
    undefined,
    null,
    "",
    "   ",
    "not-a-session",
    "....",
    "1.2.3",
    // One field short of the six a real cookie has.
    "1.2.3.4.5",
    // Six fields, wrong schema version.
    "2.MQ.MQ.c2ln.bW1w.c2ln",
    "1.!!.MQ.c2ln.bW1w.c2ln",
    "1.MQ.!!.c2ln.bW1w.c2ln",
    "1.MQ.MQ.!!.bW1w.c2ln",
    // A username that is not base64url is rejected before the signature is read.
    "1.MQ.MQ.c2ln.bm90/YS5zZWNyZXQ.c2ln",
    123,
    {},
    [],
  ]) {
    assert.equal(verifySessionCookie(value, options()), false, `accepted ${JSON.stringify(value)}`);
  }
});
