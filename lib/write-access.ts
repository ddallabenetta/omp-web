import { lstatSync, realpathSync } from "fs";
import path from "path";
import { normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import type { WebIdentity } from "./request-identity";

/**
 * Write access, deliberately narrower than read access, and per identity.
 *
 * The read allowlist has an admin-only root of `/` (so the explorer breadcrumb
 * and the Up button can reach the filesystem root). That is a *navigation*
 * root, and it is not made safe by the OS: the service runs as one account, so
 * the kernel only ever sees that account and hands over every file it can read.
 * A root of `/` makes `isPathWithinRoots` true for every absolute path, so for
 * an admin the read allowlist narrows nothing at all. (Verified against the
 * real function — with `{"/"}` it accepts `/etc/passwd` and
 * `/proc/self/environ`.)
 *
 * It stops nothing at all for a *write*. `renameSync("/etc/hosts", "/tmp/x")`
 * needs write permission on both sides and no read permission on either, so a
 * write guard that reused the read allowlist would hand out arbitrary-write on
 * every path the service can write, with a button on it.
 *
 * So this module builds its own root set from the parts of the read allowlist
 * that name an actual project, and never inherits `/`:
 *
 * - a path inside any session cwd or project root of *this* identity is
 *   writable;
 * - a path inside `OMP_WEB_ALLOWED_ROOTS` is writable, because an operator set
 *   it explicitly (admins only — it is in the admin branch of the read set);
 * - the home directory itself is NOT writable, only what is below a project in
 *   it — a bare home root would re-open the same hole one level down;
 * - `/` and every other ancestor of a project root is NOT writable.
 *
 * Everything is resolved through realpath before the comparison, so a symlink
 * pointing out of a project cannot be used to write outside it.
 *
 * Every function takes the identity explicitly and none of them has a default.
 * A default here would be a silent privilege grant the first time somebody
 * forgets the argument, and these are the functions a write goes through.
 */
declare global {
  // Mirrors __ompAllowedRootsCache, but for the narrower write set, and keyed
  // by identity so one account's writable roots are not another's.
  var __ompWriteRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

const WRITE_ROOTS_TTL_MS = 5_000;

function writableRootsCache(): Map<string, { roots: Set<string>; expiresAt: number }> {
  if (!globalThis.__ompWriteRootsCache) {
    globalThis.__ompWriteRootsCache = new Map<string, { roots: Set<string>; expiresAt: number }>();
  }
  return globalThis.__ompWriteRootsCache;
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/**
 * Roots a write may land in for `identity`, minus the always-on `/`.
 *
 * The cache is keyed by identity: a shared set would let one account's
 * projects become another's writable roots.
 */
export async function getWritableRoots(identity: WebIdentity | null): Promise<Set<string>> {
  if (!identity) return new Set<string>();

  const key = `${identity.username}\u0000${identity.isAdmin ? "admin" : "user"}`;
  const now = Date.now();
  const cache = writableRootsCache();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.roots;

  // The read allowlist already unions session cwds, project roots, the
  // omp-cwd-* directories and OMP_WEB_ALLOWED_ROOTS — plus `/`. Taking it as
  // the starting point and dropping the filesystem root reproduces the first
  // four exactly, without duplicating the session scan.
  const readRoots = await getAllowedFileRoots(identity);
  const roots = new Set<string>();
  for (const root of readRoots) {
    const resolved = path.resolve(normalizeSlashes(root));
    // `path.parse(resolved).root` is `/` on posix and `C:\` on Windows; those
    // are the always-on entries we refuse to inherit. A project that happens to
    // sit at a drive root is still reachable through its own path, so nothing
    // real is lost.
    //
    // This one line is the entire write boundary for an admin, and it is
    // verified by mutation rather than by inspection: delete it, and
    // `isWritePathAllowed("/etc/hostname", …)` flips from false to true — as do
    // `/etc/passwd` and `/root/.ssh/authorized_keys`, which is to say a
    // compromised admin password becomes arbitrary write, including SSH keys
    // of the account the service runs as.
    //
    // It is worth stating why a test that only watches the refusals would not
    // notice. `/etc/hostname` is refused for two independent reasons: the
    // filesystem root is filtered out here, *and* the file sits in no project.
    // A test asserting the 403 passes either way, so it proves nothing about
    // this line. `lib/write-access.identity.test.mjs` therefore asserts the
    // filtered *set* — that no write root is a bare filesystem root — which is
    // the property that actually does the work. Removing the line fails five
    // tests, not one.
    if (resolved === path.parse(resolved).root) continue;
    roots.add(resolved);
  }

  cache.set(key, { roots, expiresAt: now + WRITE_ROOTS_TTL_MS });
  return roots;
}

/**
 * True when `target` is inside a writable root, after symlink resolution.
 *
 * `mustExist` distinguishes the two ways the realpath check can fail. A path
 * that does not exist yet — a directory about to be created, a rename
 * destination — cannot be resolved, so its deepest existing ancestor is
 * resolved instead and the check runs on that plus the remaining segments.
 * That is what keeps a symlinked parent from smuggling the write out of the
 * project.
 */
export async function isWritePathAllowed(
  target: string,
  options: { mustExist: boolean },
  identity: WebIdentity | null
): Promise<boolean> {
  const roots = await getWritableRoots(identity);
  if (roots.size === 0) return false;

  const absolute = path.resolve(normalizeSlashes(target));
  const resolver = isWindowsAbsolutePath(absolute) ? path.win32 : path;

  if (options.mustExist) return isExistingPathWithinRoots(absolute, roots);

  const tail: string[] = [resolver.basename(absolute)];
  let ancestor = resolver.dirname(absolute);
  for (;;) {
    try {
      const rejoined = tail.reduce((acc, segment) => path.join(acc, segment), realpathSync(ancestor));
      return isPathWithinRoots(rejoined, roots);
    } catch {
      const parent = resolver.dirname(ancestor);
      if (parent === ancestor) return false;
      tail.unshift(resolver.basename(ancestor));
      ancestor = parent;
    }
  }
}

export type WriteDenialReason = "source-not-writable" | "destination-not-writable" | "not-allowed";

export interface WriteAuthorization {
  ok: boolean;
  reason?: WriteDenialReason;
  source?: string;
  destination?: string;
}

/**
 * Authorize a move or a copy. Both ends must pass.
 *
 * A copy only writes to the destination, so the source is checked for
 * readability rather than writability — otherwise "copy this file" would
 * require write access to the file itself, which is not how copying works and
 * would be surprising. A move writes to both: the source is destroyed.
 */
export async function authorizeTransfer(
  source: string,
  destination: string,
  mode: "move" | "copy",
  identity: WebIdentity | null
): Promise<WriteAuthorization> {
  if (!(await isExistingFilePathAllowed(source, await getAllowedFileRoots(identity)))) {
    return { ok: false, reason: "not-allowed", source, destination };
  }
  if (mode === "move" && !(await isWritePathAllowed(source, { mustExist: true }, identity))) {
    return { ok: false, reason: "source-not-writable", source, destination };
  }
  if (!(await isWritePathAllowed(destination, { mustExist: false }, identity))) {
    return { ok: false, reason: "destination-not-writable", source, destination };
  }
  return { ok: true, source, destination };
}

/**
 * Reject a destination that would clobber something.
 *
 * A move or copy onto an existing path is refused rather than silently
 * overwriting: the user cannot see what was there before it is gone, and the
 * source may be the only copy.
 *
 * `lstatSync`, not `statSync`: a symlink whose target is gone still occupies
 * the name, and creating a file there would write *through* the link. Following
 * it with `stat` would report the destination as free and hand the caller a
 * path that redirects the write somewhere else entirely.
 */
export function destinationExists(destination: string): boolean {
  try {
    lstatSync(destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `child` is `parent` or lives below it. Refuses "copy this folder
 * into itself", which would otherwise recurse until the disk is full.
 */
export function isSameOrBelow(parent: string, child: string): boolean {
  const useWindowsRules = isWindowsAbsolutePath(parent) || isWindowsAbsolutePath(child);
  const resolver = useWindowsRules ? path.win32 : path;
  const sep = useWindowsRules ? "\\" : path.sep;
  const normalizedParent = resolver.resolve(parent);
  const normalizedChild = resolver.resolve(child);
  const comparableParent = useWindowsRules ? normalizedParent.toLowerCase() : normalizedParent;
  const comparableChild = useWindowsRules ? normalizedChild.toLowerCase() : normalizedChild;
  const withSep = comparableParent.endsWith(sep) ? comparableParent : comparableParent + sep;
  return comparableChild === comparableParent || comparableChild.startsWith(withSep);
}

export { normalizeSlashes };
