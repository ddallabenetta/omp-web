import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * These tests cover the write boundary, not the filesystem.
 *
 * `getWritableRoots()` derives from `getAllowedFileRoots()`, which scans the
 * real omp sessions on disk, so the set cannot be pinned by asserting an exact
 * list — and it is not stable across machines either: a developer with a
 * session in /tmp would make /tmp a write root, which is exactly what happened
 * when the first version of this file used os.tmpdir() as its "forbidden"
 * location and passed for the wrong reason.
 *
 * What matters is the *shape* of the rule: the filesystem root and the home
 * directory are never writable, and a path that no root covers is refused
 * regardless of how it is spelled. Those are the properties a future change
 * could quietly break, so they are what gets asserted — using locations that
 * are forbidden on every machine.
 */

/** Locations no omp session cwd will ever be, on any machine. */
const ALWAYS_FORBIDDEN = ["/etc/passwd", "/usr/bin", "/var/lib/dpkg"];

async function loadSubject() {
  return import("./write-access.ts");
}

/** The first writable root, or null when this machine has no omp session. */
async function firstWritableRoot() {
  const { getWritableRoots } = await loadSubject();
  const roots = await getWritableRoots();
  for (const root of roots) {
    if (fs.existsSync(root)) return root;
  }
  return null;
}

test("the filesystem root is never a write root", async () => {
  const { getWritableRoots } = await loadSubject();

  for (const root of await getWritableRoots()) {
    const resolved = path.resolve(root);
    assert.notEqual(
      resolved,
      path.parse(resolved).root,
      `the filesystem root must not be writable, but ${root} is in the set`,
    );
  }
});

test("the home directory is not itself a write root", async () => {
  const { getWritableRoots } = await loadSubject();

  // A bare home root would let a write land anywhere in the user's home, which
  // is the same hole as allowing `/`, one level down.
  assert.equal((await getWritableRoots()).has(path.resolve(os.homedir())), false);
});

test("system paths are refused whether or not they exist", async () => {
  const { isWritePathAllowed } = await loadSubject();

  for (const target of ALWAYS_FORBIDDEN) {
    // mustExist false and true must agree: a path that does not exist yet is
    // judged by where it would land, and that judgement must not be looser
    // than the one for a path that is already there.
    assert.equal(await isWritePathAllowed(target, { mustExist: false }), false, target);
    assert.equal(await isWritePathAllowed(target, { mustExist: true }), false, target);
  }
});

test("a path that does not exist yet is judged by where it would land", async () => {
  const { isWritePathAllowed } = await loadSubject();

  const inside = await firstWritableRoot();
  if (!inside) return; // No omp session on this machine; nothing to prove.

  const notYetCreated = path.join(inside, "omp-web-should-not-exist", "nested", "file.txt");

  // mustExist:false resolves the deepest existing ancestor, so a path about to
  // be created is allowed on the strength of its parent.
  assert.equal(await isWritePathAllowed(notYetCreated, { mustExist: false }), true);
  // mustExist:true cannot resolve it, so it is refused — which is why the routes
  // pick the right one per operation rather than defaulting to true.
  assert.equal(await isWritePathAllowed(notYetCreated, { mustExist: true }), false);
});

test("a traversal out of an allowed root is refused", async () => {
  const { isWritePathAllowed } = await loadSubject();

  const inside = await firstWritableRoot();
  if (!inside) return;

  // Climbs out with .. segments. path.resolve collapses these, so the result
  // must be judged on where it actually lands, not on the string prefix — a
  // prefix check would pass here and hand out a write outside the project.
  const escaping = path.join(inside, "..", "..", "..", "..", "etc", "passwd");
  assert.equal(await isWritePathAllowed(escaping, { mustExist: false }), false);
});

test("a symlink out of an allowed root is refused", async () => {
  const { isWritePathAllowed } = await loadSubject();

  const inside = await firstWritableRoot();
  if (!inside) return;

  // /etc is a directory that exists, is never a write root, and cannot be
  // written to here even if the test user is root — which is the point: the
  // guard is about the allowlist, not about OS permissions.
  const linkPath = path.join(inside, `omp-web-escape-link-${process.pid}`);
  try {
    fs.symlinkSync("/etc", linkPath);
  } catch {
    return; // Cannot create symlinks here; the realpath guard is untestable.
  }

  try {
    // The link's literal path starts inside the project, so only realpath
    // resolution catches it.
    const throughLink = path.join(linkPath, "passwd");
    assert.equal(await isWritePathAllowed(throughLink, { mustExist: true }), false);
    assert.equal(await isWritePathAllowed(throughLink, { mustExist: false }), false);
  } finally {
    try { fs.unlinkSync(linkPath); } catch { /* best effort */ }
  }
});

test("a transfer from a forbidden path is refused and says why", async () => {
  const { authorizeTransfer } = await loadSubject();

  const refused = await authorizeTransfer("/etc/passwd", "/etc/shadow", "copy");

  assert.equal(refused.ok, false);
  // A refusal must name which end failed, or the UI can say nothing useful.
  assert.ok(
    ["not-allowed", "source-not-writable", "destination-not-writable"].includes(refused.reason),
    `unexpected reason: ${refused.reason}`,
  );
});

test("a move needs write access to the source, a copy does not", async () => {
  const { authorizeTransfer } = await loadSubject();

  const inside = await firstWritableRoot();
  if (!inside) return;

  // A file inside a writable project: readable and writable.
  const dir = fs.mkdtempSync(path.join(inside, "omp-web-authz-"));
  const source = path.join(dir, "file.txt");
  fs.writeFileSync(source, "x");

  try {
    const asCopy = await authorizeTransfer(source, path.join(dir, "b.txt"), "copy");
    const asMove = await authorizeTransfer(source, path.join(dir, "c.txt"), "move");
    assert.equal(asCopy.ok, true, `copy should be allowed: ${asCopy.reason}`);
    assert.equal(asMove.ok, true, `move should be allowed: ${asMove.reason}`);

    // The destination outside the project is refused for both.
    const outside = await authorizeTransfer(source, "/etc/omp-web-should-not-exist", "copy");
    assert.equal(outside.ok, false);
    assert.equal(outside.reason, "destination-not-writable");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("isSameOrBelow catches a folder being moved into itself", async () => {
  const { isSameOrBelow } = await loadSubject();

  assert.equal(isSameOrBelow("/a/b", "/a/b"), true);
  assert.equal(isSameOrBelow("/a/b", "/a/b/c"), true);
  assert.equal(isSameOrBelow("/a/b", "/a/b/c/d"), true);
  assert.equal(isSameOrBelow("/a/b", "/a/bc"), false, "a sibling with a shared prefix is not a descendant");
  assert.equal(isSameOrBelow("/a/b", "/a"), false);
  assert.equal(isSameOrBelow("/a/b", "/x/y"), false);
});

test("destinationExists counts a broken symlink as taken", async () => {
  const { destinationExists } = await loadSubject();

  const inside = await firstWritableRoot();
  if (!inside) return;

  const dir = fs.mkdtempSync(path.join(inside, "omp-web-dest-"));
  const taken = path.join(dir, "there.txt");
  fs.writeFileSync(taken, "x");

  try {
    assert.equal(destinationExists(taken), true);
    assert.equal(destinationExists(path.join(dir, "free.txt")), false);

    // A symlink whose target is gone still owns the name. Creating a file
    // there would write through the link to wherever it points, so the
    // destination is not free.
    const broken = path.join(dir, "broken-link");
    try { fs.symlinkSync(path.join(dir, "gone"), broken); } catch { return; }
    assert.equal(destinationExists(broken), true);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
