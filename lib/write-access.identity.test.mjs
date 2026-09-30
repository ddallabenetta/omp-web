import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The per-identity half of the write boundary, plus the route wiring that turns
 * it on.
 *
 * `write-access.test.mjs` covers the shape of the rule for one identity. This
 * file covers the two things that only exist now that roots are per account:
 *
 * 1. the root set is a function of the *identity*, so two accounts can hold
 *    genuinely different sets, and a missing identity holds none;
 * 2. the routes that write — `/api/files` PUT and POST, `/api/agent/new` —
 *    actually pass the identity into that check. A guard that exists and is not
 *    called is the failure this whole change exists to prevent, so the wiring is
 *    asserted rather than assumed.
 */

const ALICE = { username: "alice", isAdmin: false };
const BOB = { username: "bob", isAdmin: false };
const ADMIN = { username: "pi", isAdmin: true };

function check(condition, message) {
  assert.ok(condition, message);
}

async function loadSubject() {
  return import("./write-access.ts");
}

test("a request with no identity gets no writable roots at all", async () => {
  const { getWritableRoots, isWritePathAllowed, authorizeTransfer } = await loadSubject();

  // null means "nobody signed in": the header was missing, or the route was
  // reached without proxy.ts. It must fail closed, never widen.
  assert.deepEqual([...(await getWritableRoots(null))], []);
  assert.equal(await isWritePathAllowed("/tmp", { mustExist: false }, null), false);
  assert.equal(await isWritePathAllowed("/etc/passwd", { mustExist: true }, null), false);

  const refused = await authorizeTransfer("/etc/hosts", "/etc/hosts", "copy", null);
  assert.equal(refused.ok, false);
});

test("two accounts do not share one writable-root cache entry", async () => {
  const { getWritableRoots } = await loadSubject();

  const aliceRoots = await getWritableRoots(ALICE);
  const bobRoots = await getWritableRoots(BOB);
  const adminRoots = await getWritableRoots(ADMIN);

  // Not asserting the contents — this machine's sessions decide that. The
  // contract is that the three calls are separate objects: a shared cache entry
  // would make them literally the same Set, and one account's grant would
  // become another's write access.
  assert.notEqual(aliceRoots, bobRoots);
  assert.notEqual(aliceRoots, adminRoots);
});

test("a non-admin never inherits the filesystem root as a write root", async () => {
  const { getWritableRoots } = await loadSubject();

  for (const identity of [ALICE, BOB]) {
    for (const root of await getWritableRoots(identity)) {
      const resolved = path.resolve(root);
      assert.notEqual(
        resolved,
        path.parse(resolved).root,
        `${identity.username} must not have the filesystem root as a write root`,
      );
    }
  }
});

test("a non-admin cannot write into another account's home", async () => {
  const { isWritePathAllowed } = await loadSubject();

  // `/home/<other>` never contains a session cwd of `alice`, so no root
  // covers it regardless of how the path is spelled. Checked in both modes,
  // because a rename destination does not exist yet and takes the other branch.
  for (const target of ["/home/bob", "/home/bob/proj", "/home/bob/.ssh/id_rsa"]) {
    assert.equal(await isWritePathAllowed(target, { mustExist: true }, ALICE), false, target);
    assert.equal(await isWritePathAllowed(target, { mustExist: false }, ALICE), false, target);
  }
});

test("a non-admin cannot write to a system path", async () => {
  const { isWritePathAllowed } = await loadSubject();

  for (const target of ["/etc/passwd", "/etc/shadow", "/usr/bin", "/var/lib/dpkg"]) {
    assert.equal(await isWritePathAllowed(target, { mustExist: true }, ALICE), false, target);
    assert.equal(await isWritePathAllowed(target, { mustExist: false }, ALICE), false, target);
  }
});

test("an admin keeps the browser's reach but not the write set", async () => {
  const { getWritableRoots } = await loadSubject();

  // The read allowlist gives an admin `/` so the breadcrumb and Up button work.
  // That must not leak into writes: `/` in the write set would re-open exactly
  // the hole write-access.ts was written to close, for the account most likely
  // to be phished through a copied session.
  for (const root of await getWritableRoots(ADMIN)) {
    const resolved = path.resolve(root);
    assert.notEqual(resolved, path.parse(resolved).root, "admin write roots must exclude /");
  }
});

/**
 * Every `isWritePathAllowed` / `authorizeTransfer` call in a route, as call
 * expressions.
 *
 * The call is closed on the matching parenthesis rather than the first `)`, so
 * a call carrying an options object — `isWritePathAllowed(p, { mustExist: true },
 * identity)` — is one match and not three fragments. Getting this wrong makes
 * the assertions below pass for the wrong reason.
 */
function writeGuardCalls(source, name) {
  const calls = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  let match;
  while ((match = re.exec(source)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
    re.lastIndex = end + 1;
  }
  return calls;
}

const GUARD_ROUTES = [
  "app/api/files/[...path]/route.ts",
  "app/api/agent/new/route.ts",
  "app/api/file-actions/[...path]/route.ts",
];

test("the read allowlist is the one that has to lose the filesystem root", async () => {
  // Asserted on the *read* set, not the write set. `getWritableRoots()` filters
  // out `/` by construction, so a `/` that leaked back into the read allowlist
  // is invisible there — a mutation that hands `/` to a non-admin passes every
  // write test. This is the set `isFilePathAllowed` consults, and a root of `/`
  // makes it return true for every absolute path, which is the whole hole.
  const { getAllowedFileRoots } = await import("./file-access.ts");
  const { isFilePathAllowed } = await import("./file-access.ts");

  const asAlice = await getAllowedFileRoots(ALICE);
  check(!asAlice.has("/"), "a non-admin read allowlist must not contain /");
  assert.equal(isFilePathAllowed("/etc", asAlice), false, "alice must not reach /etc");
  assert.equal(isFilePathAllowed("/etc/passwd", asAlice), false, "alice must not reach /etc/passwd");

  // The admin keeps it, or the breadcrumb and Up button stop working.
  const asAdmin = await getAllowedFileRoots(ADMIN);
  check(asAdmin.has("/"), "an admin read allowlist must still contain /");
});

test("a non-admin read allowlist is bounded by its own home", async () => {
  const { getAllowedFileRoots, isFilePathAllowed } = await import("./file-access.ts");
  const { getUserHome } = await import("./request-identity.ts");

  const asAlice = await getAllowedFileRoots(ALICE);
  const aliceHome = getUserHome(ALICE);

  // Own home: reachable. A tenant who cannot open his own directory has a
  // boundary, not a permission model.
  check(isFilePathAllowed(aliceHome, asAlice), `alice must reach his own home ${aliceHome}`);

  // Everything outside it: not. Includes another tenant's home and the system
  // trees, which the old always-on `/` allowed for every logged-in user.
  for (const foreign of ["/etc", "/var", "/root", "/home/bob", "/home/bob/secret", "/proc/self"]) {
    assert.equal(
      isFilePathAllowed(foreign, asAlice),
      false,
      `alice must not reach ${foreign}`,
    );
  }
});

test("a non-admin does not inherit the service account's scratch directories", async () => {
  // The `omp-cwd-*` scratch dirs of `/api/default-cwd` live in the home of the
  // account the process runs as, which is not the account making the request.
  // Reading that home here reproduces the machine: the service account has such
  // a directory, the tenant does not. A non-admin must not receive it as a
  // root — the allowlist is built before any path check, so once it is in, no
  // later check can take it back out.
  const { getAllowedFileRoots } = await import("./file-access.ts");
  const { isFilePathAllowed } = await import("./file-access.ts");
  const { getUserHome } = await import("./request-identity.ts");

  const serviceHome = os.homedir();
  const aliceHome = getUserHome(ALICE);
  // Nothing to prove when the service runs as the same account the test
  // impersonates; that is the admin case, asserted elsewhere.
  if (serviceHome === aliceHome) return;

  const asAlice = await getAllowedFileRoots(ALICE);
  for (const root of asAlice) {
    assert.ok(
      !root.startsWith(`${serviceHome}/`),
      `alice's allowlist contains a path in the service account's home: ${root}`,
    );
    assert.equal(
      isFilePathAllowed(path.join(serviceHome, "anything"), asAlice),
      false,
      "alice must not reach the service account's home",
    );
  }
});

test("a tenant can reach his own home before it exists, and still not escape it", async () => {
  // The home boundary has to hold in both directions: an account that has never
  // logged in has no home directory yet, and refusing his own home is a lockout,
  // not a permission model. But once a home does exist, a symlink inside it must
  // not become a way out — the lexical fallback that admits a not-yet-made
  // directory must not admit a realpath escape either.
  //
  // Tested against `isPathWithinRoots`' two halves directly rather than through
  // `getUserHome`, because that resolves the home root from the environment at
  // import time and another test in this file may already have imported it.
  const { isExistingPathWithinRoots, isPathWithinRoots } = await import("./path-security.ts");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tenant-home-"));
  try {
    const home = path.join(base, "omp-test-tenant");

    // Not created yet: the owner must still be recognised. This is the case that
    // motivated the fallback — realpathSync throws on both sides and the naive
    // form answered false for the account's own home.
    assert.equal(fs.existsSync(home), false, "precondition: home does not exist");
    assert.equal(
      isExistingPathWithinRoots(path.join(home, "omp-cwd-20260930"), new Set([home])),
      false,
      "precondition: the resolved check cannot speak about unresolvable paths",
    );
    assert.equal(
      isPathWithinRoots(path.join(home, "omp-cwd-20260930"), new Set([home])),
      true,
      "the lexical check does, which is why the fallback needs it",
    );

    // Once the home exists, a link inside it is an escape, and the resolved
    // check says so. This is the property the fallback must not weaken.
    fs.mkdirSync(home, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tenant-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret"), "s");
      const link = path.join(home, "escape");
      fs.symlinkSync(outside, link, "dir");
      const throughLink = path.join(link, "secret");
      assert.equal(
        isPathWithinRoots(throughLink, new Set([home])),
        true,
        "precondition: the link itself sits inside the home, lexically",
      );
      assert.equal(
        isExistingPathWithinRoots(throughLink, new Set([home])),
        false,
        "a symlink inside the home must not become a way out of it",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("isPathInUserHome admits an uncreated home and refuses an escape from it", async () => {
  // The real function, not its two halves. Runs in a child process because
  // `getUserHome` resolves the home root from the environment when
  // request-identity is first imported, and this file has already imported it
  // by now — in-process the sandbox override would come too late.
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hih-"));
    process.env.OMP_WEB_HOME_ROOT = base;
    const { isPathInUserHome } = await import(${JSON.stringify(new URL("./path-security.ts", import.meta.url).href)});
    const id = { username: "t1", isAdmin: false };
    const home = path.join(base, "t1");
    const out = {};
    out.beforeExists = isPathInUserHome(id, path.join(home, "omp-cwd-20260930"));
    fs.mkdirSync(home, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hih-out-"));
    fs.symlinkSync(outside, path.join(home, "escape"), "dir");
    out.ownHome = isPathInUserHome(id, home);
    out.escape = isPathInUserHome(id, path.join(home, "escape", "x"));
    out.traversal = isPathInUserHome(id, path.join(home, "..", "..", "etc"));
    out.nullIdentity = isPathInUserHome(null, home);
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    console.log("__RESULT__" + JSON.stringify(out));
  `;
  const { execFileSync } = await import("node:child_process");
  const raw = execFileSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The child may print loader noise before the answer; the marker selects ours.
  const marked = raw.split("\n").find((line) => line.startsWith("__RESULT__"));
  assert.ok(marked, `child produced no result: ${raw.slice(0, 400)}`);
  const result = JSON.parse(marked.slice("__RESULT__".length));

  assert.equal(result.beforeExists, true, "an account must reach a dir in his own not-yet-created home");
  assert.equal(result.ownHome, true, "own existing home is reachable");
  assert.equal(result.escape, false, "a symlink inside the home must not be a way out");
  assert.equal(result.traversal, false, "traversal out of the home is refused");
  assert.equal(result.nullIdentity, false, "no identity, no home");
});

test("the filesystem root is filtered out of the write set, and that filter carries the guard", async () => {
  // `/` is in the admin's *read* allowlist, on purpose, so the breadcrumb and
  // the Up button work. Dropping it from the *write* set is what keeps a
  // compromised admin password from becoming arbitrary write: without the filter
  // `/etc/hostname` is writable, because the only thing between an admin and
  // the whole filesystem on the write side is this line.
  //
  // Asserted as a property of the filtered set rather than as "the file is
  // refused", because the refusal is also reachable by the file simply not
  // being in any project. Removing the filter has to be what breaks this.
  const { getWritableRoots, isWritePathAllowed } = await import("./write-access.ts");
  const { getAllowedFileRoots } = await import("./file-access.ts");

  const asAdmin = await getWritableRoots(ADMIN);
  check(!asAdmin.has("/"), "the write set must not contain the filesystem root");
  for (const root of asAdmin) {
    assert.notEqual(path.resolve(root), path.parse(path.resolve(root)).root, `write root is a bare filesystem root: ${root}`);
  }

  // The read side keeps it — that asymmetry is the design, not an oversight.
  check((await getAllowedFileRoots(ADMIN)).has("/"), "the admin read set must still contain /");

  // And the consequence holds: a system file outside every project is refused
  // for an admin, even though the same admin may read it.
  assert.equal(
    await isWritePathAllowed("/etc/hostname", { mustExist: true }, ADMIN),
    false,
    "an admin may read /etc/hostname but must not be able to overwrite it",
  );
});

test("a missing identity gets an empty read allowlist", async () => {
  const { getAllowedFileRoots, isFilePathAllowed } = await import("./file-access.ts");

  const roots = await getAllowedFileRoots(null);
  assert.equal(roots.size, 0, "no identity, no roots");
  assert.equal(isFilePathAllowed("/etc", roots), false);
  assert.equal(isFilePathAllowed("/", roots), false);
});

test("every write guard in the routes takes an identity", async () => {
  // Wiring, not behaviour: a guard that is defined and never called is exactly
  // how `/api/files` PUT was able to overwrite any readable file. Asserted
  // per call rather than "at least one call has it", because a route with three
  // guarded writes and one unguarded passes that weaker check while leaving the
  // hole open.
  for (const route of GUARD_ROUTES) {
    const source = await readFile(route, "utf8");
    const calls = [
      ...writeGuardCalls(source, "isWritePathAllowed"),
      ...writeGuardCalls(source, "authorizeTransfer"),
    ];
    assert.ok(calls.length > 0, `${route} must call a write guard at all`);
    for (const call of calls) {
      assert.match(
        call,
        /,\s*identity\s*\)$/,
        `${route}: write guard without an identity argument: ${call}`,
      );
    }
  }
});

test("the files route guards both its write paths", async () => {
  // Two, not one: POST (upload) and PUT (editor save) are separate write paths,
  // and each was unguarded before. A count of one means one of them regressed.
  const source = await readFile("app/api/files/[...path]/route.ts", "utf8");
  const calls = writeGuardCalls(source, "isWritePathAllowed");
  assert.equal(
    calls.length,
    2,
    `expected a guard on the upload path and one on the editor-save path, found: ${calls.join(" | ")}`,
  );
  // Both operands are known to exist when the check runs — the upload
  // directory was statSync'd, the editor file is about to be rewritten in
  // place — so both must resolve the real path. `mustExist: false` walks up to
  // the nearest existing ancestor and rejoins the remaining segments *without*
  // resolving them, so a symlink in the final position passes it; measured
  // against a link inside a writable root pointing outside it, `false` returns
  // true where `true` does not. For a path that exists, `true` is the honest
  // mode on both write paths.
  for (const call of calls) {
    assert.match(
      call,
      /mustExist:\s*true/,
      `a guard on an existing path must use mustExist: true: ${call}`,
    );
  }
});

test("every route refuses a null identity before it looks at a path", async () => {
  for (const route of GUARD_ROUTES) {
    const source = await readFile(route, "utf8");
    assert.match(source, /getRequestIdentity\(/, `${route} must resolve an identity`);
    assert.match(source, /if \(!identity\)/, `${route} must refuse a null identity`);
  }
});

test("the files route derives its roots from the identity, not the path", async () => {
  const source = await readFile("app/api/files/[...path]/route.ts", "utf8");

  // The path arrives in the URL, so the caller chooses it. No allowlist may be
  // built from it.
  assert.doesNotMatch(
    source,
    /getAllowedFileRoots\((filePath|realPath|directory|segments|cwd|target)\b/,
    "allowed roots must come from the identity, never from a requested path",
  );
  assert.match(source, /getAllowedFileRoots\(identity\)/);
});

async function readFile(relativePath, encoding) {
  return (await import("node:fs/promises")).readFile(
    path.join(process.cwd(), relativePath),
    encoding,
  );
}
