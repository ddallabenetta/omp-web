import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const store = require("../bin/web-auth-store.js");

/** Keeps scrypt cheap: these tests exercise the protocol, not the cost factor. */
const PARAMS = { cost: 16, keyLength: 32 };
const PASSWORD = "a-long-enough-password";

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auth-"));
  const options = { file: join(dir, "omp-web-auth.json"), env: {}, params: PARAMS };
  try {
    return run(options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("starts unlocked when no credential file exists", () => {
  withStore((options) => {
    const status = store.getWebAuthStatus(options);
    assert.equal(status.enabled, false);
    assert.equal(status.configured, false);
    assert.equal(status.source, "none");
    assert.equal(store.resolveWebAuthPolicy(options).mode, "open");
  });
});

test("stores the password as a scrypt digest and never in plaintext", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);

    const contents = readFileSync(options.file, "utf8");
    assert.equal(contents.includes(PASSWORD), false);
    const parsed = JSON.parse(contents);
    assert.equal(parsed.password.algorithm, "scrypt");
    assert.ok(parsed.password.salt.length > 0);
    assert.ok(parsed.password.hash.length > 0);
  });
});

test("writes the credential file with owner-only permissions", { skip: process.platform === "win32" }, () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    assert.equal(statSync(options.file).mode & 0o777, 0o600);
  });
});

test("verifies the stored password and rejects everything else", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
    assert.equal(store.verifyWebPassword(`${PASSWORD} `, options), false);
    assert.equal(store.verifyWebPassword("", options), false);
    assert.equal(store.verifyWebPassword(undefined, options), false);
  });
});

test("a fresh salt is drawn per password, so the same secret hashes differently", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const first = JSON.parse(readFileSync(options.file, "utf8")).password;
    store.setWebPassword(PASSWORD, options);
    const second = JSON.parse(readFileSync(options.file, "utf8")).password;

    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
  });
});

test("the lock can be switched off and back on without losing the password", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);

    const disabled = store.setWebPasswordEnabled(false, options);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.stored, true);
    assert.equal(store.resolveWebAuthPolicy(options).mode, "open");

    const enabled = store.setWebPasswordEnabled(true, options);
    assert.equal(enabled.enabled, true);
    assert.equal(store.resolveWebAuthPolicy(options).mode, "stored");
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
  });
});

test("refuses to lock the server with no password to unlock it", () => {
  withStore((options) => {
    assert.throws(() => store.setWebPasswordEnabled(true, options), /Set a password/);
  });
});

test("clearing the password unlocks the server", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const status = store.clearWebPassword(options);

    assert.equal(status.configured, false);
    assert.equal(status.enabled, false);
    assert.equal(store.resolveWebAuthPolicy(options).mode, "open");
    assert.equal(readFileSync(options.file, "utf8").includes("\"password\""), false);
  });
});

test("OMP_WEB_PASSWORD overrides the stored credential", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const env = { OMP_WEB_PASSWORD: "from-the-environment" };

    const status = store.getWebAuthStatus({ ...options, env });
    assert.equal(status.source, "environment");
    assert.equal(status.managedByEnvironment, true);
    assert.equal(status.enabled, true);

    assert.equal(store.verifyWebPassword("from-the-environment", { ...options, env }), true);
    assert.equal(store.verifyWebPassword(PASSWORD, { ...options, env }), false);
  });
});

test("an unparsable credential file fails closed instead of unlocking the server", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    writeFileSync(options.file, "{ not json");

    assert.equal(store.resolveWebAuthPolicy(options).mode, "unavailable");
    assert.equal(store.getWebAuthStatus(options).unreadable, true);
  });
});

test("a locked config whose digest is unusable fails closed", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const config = JSON.parse(readFileSync(options.file, "utf8"));
    config.password.cost = 12345; // not a power of two
    writeFileSync(options.file, JSON.stringify(config));

    assert.equal(store.resolveWebAuthPolicy(options).mode, "unavailable");
  });
});

test("rejects passwords too short to be worth storing", () => {
  assert.match(store.validatePassword("short"), /at least/);
  assert.match(store.validatePassword("        "), /whitespace/);
  assert.equal(store.validatePassword(undefined), "A password is required.");
  assert.equal(store.validatePassword(PASSWORD), null);
  withStore((options) => {
    assert.throws(() => store.setWebPassword("short", options), /at least/);
  });
});

test("a recovery code sets a new password and is spent in the process", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);

    const issued = store.issueRecoveryCode(options);
    assert.equal(issued.ok, true);
    assert.match(issued.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // The code itself is never persisted in the clear.
    assert.equal(readFileSync(options.file, "utf8").includes(issued.code), false);

    const result = store.consumeRecoveryCode(issued.code, "brand-new-password", options);
    assert.equal(result.ok, true);
    assert.equal(store.verifyWebPassword("brand-new-password", options), true);
    assert.equal(store.verifyWebPassword(PASSWORD, options), false);

    const replay = store.consumeRecoveryCode(issued.code, "another-password", options);
    assert.deepEqual(replay, { ok: false, reason: "no-code" });
  });
});

test("recovery codes are read back forgivingly", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const issued = store.issueRecoveryCode(options);

    const typed = issued.code.toLowerCase().replace(/-/g, " ");
    assert.equal(store.consumeRecoveryCode(typed, "brand-new-password", options).ok, true);
  });
});

test("a wrong recovery code is spent after a bounded number of attempts", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    store.issueRecoveryCode(options);

    for (let attempt = store.RECOVERY_MAX_ATTEMPTS; attempt > 1; attempt -= 1) {
      const result = store.consumeRecoveryCode("0000-0000-0000", "brand-new-password", options);
      assert.equal(result.reason, "invalid-code");
      assert.equal(result.remainingAttempts, attempt - 1);
    }

    assert.equal(store.consumeRecoveryCode("0000-0000-0000", "brand-new-password", options).remainingAttempts, 0);
    assert.equal(store.consumeRecoveryCode("0000-0000-0000", "brand-new-password", options).reason, "no-code");
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
  });
});

test("an expired recovery code is refused and discarded", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const issued = store.issueRecoveryCode(options);

    const later = issued.expiresAt + 1;
    assert.equal(store.consumeRecoveryCode(issued.code, "brand-new-password", { ...options, now: later }).reason, "expired");
    assert.equal(store.consumeRecoveryCode(issued.code, "brand-new-password", options).reason, "no-code");
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
  });
});

test("recovery codes cannot be minted in a tight loop", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    assert.equal(store.issueRecoveryCode(options).ok, true);

    const throttled = store.issueRecoveryCode(options);
    assert.equal(throttled.ok, false);
    assert.equal(throttled.reason, "throttled");
    assert.ok(throttled.retryAfterMs > 0);
  });
});

test("setting a password invalidates a pending recovery code", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const issued = store.issueRecoveryCode(options);
    store.setWebPassword("a-different-password", options);

    assert.equal(store.consumeRecoveryCode(issued.code, "brand-new-password", options).reason, "no-code");
  });
});

test("a valid code still rejects an unacceptable new password, without being spent", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    const issued = store.issueRecoveryCode(options);

    const result = store.consumeRecoveryCode(issued.code, "short", options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-password");
    assert.equal(store.consumeRecoveryCode(issued.code, "brand-new-password", options).ok, true);
  });
});

test("resolves the credential path from the agent directory, and honours the override", () => {
  assert.equal(
    store.resolveWebAuthFile({ PI_CODING_AGENT_DIR: "/srv/omp/agent" }),
    join("/srv/omp/agent", store.WEB_AUTH_FILENAME),
  );
  assert.equal(store.resolveWebAuthFile({ OMP_WEB_AUTH_FILE: "/srv/creds.json" }), "/srv/creds.json");
  assert.match(store.resolveAgentDir({}), /\.omp[/\\]agent$/);
  assert.match(store.resolveAgentDir({ OMP_PROFILE: "work" }), /\.omp[/\\]profiles[/\\]work[/\\]agent$/);
  assert.match(store.resolveAgentDir({ OMP_PROFILE: "  " }), /\.omp[/\\]agent$/);
});

test("a new password replaces a credential file that cannot be parsed", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    writeFileSync(options.file, "{ not json");
    // Everything else refuses to touch a file it cannot read, so a mutation can
    // never silently drop a credential and unlock the server.
    assert.throws(() => store.setWebPasswordEnabled(false, options), /reset-password/);
    assert.throws(() => store.issueRecoveryCode(options), /reset-password/);

    // `omp-web --reset-password` is the way out, so it has to work here.
    const status = store.setWebPassword("a-replacement-password", options);
    assert.equal(status.enabled, true);
    assert.equal(store.resolveWebAuthPolicy(options).mode, "stored");
    assert.equal(store.verifyWebPassword("a-replacement-password", options), true);
  });
});

test("surfaces the default username when the file has none", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    assert.equal(store.getWebAuthStatus(options).username, store.DEFAULT_WEB_AUTH_USERNAME);
  });
});

test("setWebUsername persists and surfaces the new value, and trims whitespace", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);

    const status = store.setWebUsername("  bsteimer  ", options);
    assert.equal(status.username, "bsteimer");
    assert.equal(store.getWebAuthStatus(options).username, "bsteimer");
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);

    // The username is written into the same atomic record as the password.
    const parsed = JSON.parse(readFileSync(options.file, "utf8"));
    assert.equal(parsed.username, "bsteimer");
  });
});

test("setWebUsername rejects empty, whitespace-only, and whitespace-bearing values", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    for (const value of ["", "   ", "two words", "tab\there", "newline\nhere"]) {
      assert.throws(() => store.setWebUsername(value, options), /username/i, `accepted ${JSON.stringify(value)}`);
    }
    assert.equal(store.getWebAuthStatus(options).username, store.DEFAULT_WEB_AUTH_USERNAME);
  });
});

test("setWebUsername clears the verification cache so a session signed for the old username no longer matches", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    // Warm the cache with a successful verification, then rotate. The new
    // credential pair must not reuse the cached verdict for the previous
    // (username, password) — even though the password digest is unchanged.
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
    store.setWebUsername("bsteimer", options);
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);

    // A second successful verification still warms the cache under the new
    // pair, so an unrelated credential change later still busts the cache.
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
    store.setWebPassword(PASSWORD, options);
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);
  });
});

test("setWebPassword keeps any previously stored username when none is supplied", () => {
  withStore((options) => {
    store.setWebPassword(PASSWORD, options);
    store.setWebUsername("bsteimer", options);

    const status = store.setWebPassword("another-password", options);
    assert.equal(status.username, "bsteimer");
    assert.equal(store.verifyWebPassword("another-password", options), true);
  });
});

test("setWebPassword can rotate username and password in one atomic write", () => {
  withStore((options) => {
    const status = store.setWebPassword(PASSWORD, { ...options, username: "bsteimer" });
    assert.equal(status.username, "bsteimer");
    assert.equal(store.getWebAuthStatus(options).username, "bsteimer");
    assert.equal(store.verifyWebPassword(PASSWORD, options), true);

    // Empty / whitespace usernames fall through to the default — setWebPassword
    // is allowed to wipe the field, so `bsteimer` can roll back to `omp`.
    const rolledBack = store.setWebPassword(PASSWORD, { ...options, username: "   " });
    assert.equal(rolledBack.username, store.DEFAULT_WEB_AUTH_USERNAME);
  });
});

test("toggle and clear keep the stored username intact", () => {
  withStore((options) => {
    store.setWebUsername("bsteimer", options);
    store.setWebPassword(PASSWORD, options);

    assert.equal(store.setWebPasswordEnabled(false, options).username, "bsteimer");
    assert.equal(store.setWebPasswordEnabled(true, options).username, "bsteimer");
    assert.equal(store.clearWebPassword(options).username, "bsteimer");
  });
});

test("setWebUsername invalidates a cookie signed for the previous username", async () => {
  // Imported lazily so the file stays a plain Node test as the rest of the
  // suite — `bun test` only has to handle ESM in one place.
  const { issueSessionCookie, verifySessionCookie } = await import("./web-auth-session.ts");

  await withStore(async (options) => {
    store.setWebPassword(PASSWORD, options);
    // Stored mode (no env password), with the test file override so the
    // session code reads the same file we just wrote.
    const storedOptions = { ...options, env: { OMP_WEB_AUTH_FILE: options.file } };

    const aliceCookie = issueSessionCookie(storedOptions);
    assert.equal(typeof aliceCookie, "string");
    assert.equal(verifySessionCookie(aliceCookie, storedOptions), true);

    // The store can rotate just the username; the password digest is untouched.
    // The cookie was minted for the default username (`omp`), so changing to
    // `bsteimer` must invalidate it without any other action.
    store.setWebUsername("bsteimer", options);
    assert.equal(verifySessionCookie(aliceCookie, storedOptions), false);

    // A cookie minted under the new username verifies, of course.
    const bsteimerCookie = issueSessionCookie(storedOptions);
    assert.equal(verifySessionCookie(bsteimerCookie, storedOptions), true);
  });
});
