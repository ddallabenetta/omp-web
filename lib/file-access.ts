import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, getAllowedRootsCache, identityKey, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
import { getUserHome, type WebIdentity } from "./request-identity";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache of the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly. Keyed by identity, because
// the set is per-identity now: a single cached union would hand one account the
// roots of another.
const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/**
 * The roots `identity` may read.
 *
 * The argument is mandatory in the type but nullable in fact: a request whose
 * identity could not be established gets an empty set. That is the whole
 * contract. `listAllSessions()` is *not* called in that case, because it
 * returns every session on the machine including other tenants' — the
 * unfiltered scan would rebuild the very root set the identity is there to
 * narrow, and an empty result is the only genuinely safe one.
 *
 * Sessions are filtered by the same identity that gates the result, so another
 * tenant's cwd never becomes a root here.
 */
export async function getAllowedFileRoots(identity: WebIdentity | null): Promise<Set<string>> {
  if (!identity) return new Set<string>();

  const key = identityKey(identity);
  const now = Date.now();
  const cache = getAllowedRootsCache();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions({ identity });
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/omp-cwd-* directories created by the default-cwd endpoint.
  // Scanned in the *requesting* account's home, not `homedir()`: the service
  // runs as one account, so scanning the process home handed every logged-in
  // user the service account's scratch directories as browsable roots — a
  // cross-tenant read that no identity check could catch afterwards, because by
  // then the path was in the allowlist. For an admin the two coincide.
  try {
    const ownHome = identity.isAdmin ? homedir() : getUserHome(identity);
    for (const name of readdirSync(ownHome)) {
      if (/^omp-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(ownHome, name)));
      }
    }
  } catch {
    // ignore if home is unreadable or does not exist
  }

  for (const root of getAdditionalAllowedRoots(identity)) roots.add(root);

  cache.set(key, { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
  return roots;
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
