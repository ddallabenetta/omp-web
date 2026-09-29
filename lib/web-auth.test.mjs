import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const store = require("../bin/web-auth-store.js");

const STORED_PASSWORD = "a-long-enough-password";
/** Keeps scrypt cheap: these tests exercise the decision, not the cost factor. */
const PARAMS = { cost: 16, keyLength: 32 };

async function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auth-"));
  try {
    return await run({ file: join(dir, "omp-web-auth.json"), env: {}, params: PARAMS });
  } finally {
    store.clearVerificationCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadSubject() {
  return import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

test("enables password authentication only for a non-empty configured password", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(undefined), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), true);
});

test("accepts only the fixed pi username and configured password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("omp", "secret"), "secret"), true);
  assert.equal(isValidBasicAuthorization(authorization("admin", "secret"), "secret"), false);
  assert.equal(isValidBasicAuthorization(authorization("omp", "wrong"), "secret"), false);
});

test("supports UTF-8 passwords and colons in the password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(isValidBasicAuthorization(authorization("omp", password), password), true);
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const valid = authorization("omp", "secret");

  assert.equal(isValidBasicAuthorization(null, "secret"), false);
  assert.equal(isValidBasicAuthorization("Bearer token", "secret"), false);
  assert.equal(isValidBasicAuthorization("Basic !!!", "secret"), false);
  assert.equal(isValidBasicAuthorization(`${valid}!`, "secret"), false);
  assert.equal(isValidBasicAuthorization(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
    "secret",
  ), false);
});

test("does not authenticate when password protection is disabled", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("omp", ""), ""), false);
  assert.equal(isValidBasicAuthorization(authorization("omp", "secret"), undefined), false);
});

test("splits basic credentials on the first colon only", async () => {
  const { parseBasicCredentials } = await loadSubject();
  assert.deepEqual(parseBasicCredentials(authorization("omp", "a:b:c")), { username: "omp", password: "a:b:c" });
  assert.equal(parseBasicCredentials("Basic !!!"), null);
  assert.equal(parseBasicCredentials(null), null);
});

test("lets every request through while no password is configured", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    assert.equal(authorizeWebRequest(null, options), "allow");
  });
});

test("authorizes against the stored password", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);

    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), options), "allow");
    assert.equal(authorizeWebRequest(authorization("omp", "wrong-password"), options), "unauthorized");
    assert.equal(authorizeWebRequest(authorization("admin", STORED_PASSWORD), options), "unauthorized");
    assert.equal(authorizeWebRequest(null, options), "unauthorized");
  });
});

test("authorizes against OMP_WEB_PASSWORD ahead of the stored password", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    const withEnv = { ...options, env: { OMP_WEB_PASSWORD: "environment-secret" } };

    assert.equal(authorizeWebRequest(authorization("omp", "environment-secret"), withEnv), "allow");
    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), withEnv), "unauthorized");
  });
});

test("stops refusing once the lock is switched off", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    store.setWebPasswordEnabled(false, options);

    assert.equal(authorizeWebRequest(null, options), "allow");
  });
});

test("reports an unreadable credential file rather than unlocking", async () => {
  const { authorizeWebRequest } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    writeFileSync(options.file, "{ not json");

    assert.equal(authorizeWebRequest(authorization("omp", STORED_PASSWORD), options), "unavailable");
  });
});

test("the file-stored username wins over OMP_WEB_USERNAME", async () => {
  const { getExpectedUsername } = await loadSubject();
  await withStore(async (options) => {
    store.setWebUsername("bsteimer", options);
    // `OMP_WEB_AUTH_FILE` is what `resolveWebAuthFile` honours, so the test
    // has to thread the temp credential file through the env for both the
    // resolver and the override scenarios.
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "omp" }), "bsteimer");
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "" }), "bsteimer");
  });
});

test("an empty file-stored username falls back to OMP_WEB_USERNAME then the default", async () => {
  const { getExpectedUsername } = await loadSubject();
  await withStore(async (options) => {
    store.setWebPassword(STORED_PASSWORD, options);
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    // No username field at all → default.
    assert.equal(getExpectedUsername({ ...fileEnv }), "omp");
    // Env wins when the file has nothing.
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "from-env" }), "from-env");

    // Whitespace-only in the file is also a miss, so the env picks up.
    writeFileSync(options.file, JSON.stringify({
      version: 1,
      enabled: true,
      username: "   ",
    }));
    assert.equal(getExpectedUsername({ ...fileEnv, OMP_WEB_USERNAME: "from-env" }), "from-env");
  });
});

test("a settings-panel write invalidates the cached username without an explicit clear", async () => {
  const { getExpectedUsername } = await loadSubject();
  // Clear the cross-test cache so this scenario starts from a known state.
  delete globalThis.__ompWebAuthUsernameCache;
  await withStore(async (options) => {
    const fileEnv = { ...options.env, OMP_WEB_AUTH_FILE: options.file };

    store.setWebPassword(STORED_PASSWORD, options);
    assert.equal(getExpectedUsername({ ...fileEnv }), "omp");

    store.setWebUsername("bsteimer", options);
    // A fresh call without clearing the global cache must already see the
    // rotated username — the file's new mtimeMs is what invalidates the
    // cache, not a separate teardown hook.
    assert.equal(getExpectedUsername({ ...fileEnv }), "bsteimer");
  });
});
