import { lstatSync, realpathSync } from "fs";
import path from "path";
import { normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";

/**
 * Write access, deliberately narrower than read access.
 *
 * `getAdditionalAllowedRoots()` includes `/` unconditionally so the explorer
 * breadcrumb and the Up button can reach the filesystem root. That is fine for
 * browsing — the OS refuses a read the process has no permission for, so the
 * allowlist is not what stops you there. It stops nothing at all for a *write*.
 * `renameSync("/etc/hosts", "/tmp/x")` needs write permission on both sides and
 * no read permission on either, so a write guard that reused the read
 * allowlist would hand out arbitrary-write on every path the service can
 * write, with a button on it.
 *
 * So this module builds its own root set from the parts of the read allowlist
 * that name an actual project, and never inherits `/`:
 *
 * - a path inside any omp session cwd or project root is writable;
 * - a path inside `OMP_WEB_ALLOWED_ROOTS` is writable, because an operator set
 *   it explicitly;
 * - the home directory itself is NOT writable, only what is below a project in
 *   it — a bare home root would re-open the same hole one level down;
 * - `/` and every other ancestor of a project root is NOT writable.
 *
 * Everything is resolved through realpath before the comparison, so a symlink
 * pointing out of a project cannot be used to write outside it.
 */
declare global {
  // Mirrors __ompAllowedRootsCache, but for the narrower write set.
  var __ompWriteRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
}

const WRITE_ROOTS_TTL_MS = 5_000;

function isWindowsAbsolutePath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/**
 * Roots a write may land in. Built from the same session scan the read
 * allowlist uses, minus the always-on `/`.
 */
export async function getWritableRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__ompWriteRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  // The read allowlist already unions session cwds, project roots, the
  // omp-cwd-* directories and OMP_WEB_ALLOWED_ROOTS — plus `/`. Taking it as
  // the starting point and dropping the filesystem root reproduces the first
  // four exactly, without duplicating the session scan.
  const readRoots = await getAllowedFileRoots();
  const roots = new Set<string>();
  for (const root of readRoots) {
    const resolved = path.resolve(normalizeSlashes(root));
    // `path.parse(resolved).root` is `/` on posix and `C:\` on Windows; those
    // are the always-on entries we refuse to inherit. A project that happens to
    // sit at a drive root is still reachable through its own path, so nothing
    // real is lost.
    if (resolved === path.parse(resolved).root) continue;
    roots.add(resolved);
  }

  globalThis.__ompWriteRootsCache = { roots, expiresAt: now + WRITE_ROOTS_TTL_MS };
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
  options: { mustExist: boolean }
): Promise<boolean> {
  const roots = await getWritableRoots();
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
  mode: "move" | "copy"
): Promise<WriteAuthorization> {
  if (!(await isExistingFilePathAllowed(source, await getAllowedFileRoots()))) {
    return { ok: false, reason: "not-allowed", source, destination };
  }
  if (mode === "move" && !(await isWritePathAllowed(source, { mustExist: true }))) {
    return { ok: false, reason: "source-not-writable", source, destination };
  }
  if (!(await isWritePathAllowed(destination, { mustExist: false }))) {
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
