import { getUserHome, type WebIdentity } from "./request-identity";

/**
 * Roots that are browsable in addition to the ones derived from sessions.
 *
 * Everything here is a function of the *identity* of the request, never of the
 * path being requested. That is the whole point of the module: the caller picks
 * the path, so a root set derived from the path would approve itself.
 */
declare global {
  /**
   * Explicitly granted roots, bucketed per identity.
   *
   * A `Map` and not one process-wide `Set`: a single shared set means one user
   * calling `allowFileRoot()` widens the filesystem for every other user. Since
   * the read allowlist also feeds the write allowlist, that is a cross-tenant
   * escalation and not a nuisance.
   */
  var __ompAdditionalAllowedRoots: Map<string, Set<string>> | undefined;
  /**
   * Short-TTL cache of the assembled root set, keyed by identity because the
   * set is assembled per identity. Owned here so `allowFileRoot()` can
   * invalidate it.
   */
  var __ompAllowedRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

/** Bucket for grants that predate identities — operator-driven endpoints only. */
const UNATTRIBUTED = "\u0000unattributed";

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function identityKey(identity?: WebIdentity | null): string {
  if (!identity) return UNATTRIBUTED;
  return `${identity.username}\u0000${identity.isAdmin ? "admin" : "user"}`;
}

function buckets(): Map<string, Set<string>> {
  if (!globalThis.__ompAdditionalAllowedRoots) {
    globalThis.__ompAdditionalAllowedRoots = new Map<string, Set<string>>();
  }
  return globalThis.__ompAdditionalAllowedRoots;
}

function bucketFor(key: string): Set<string> {
  const map = buckets();
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Set<string>();
    map.set(key, bucket);
  }
  return bucket;
}

function envRoots(): string[] {
  const envRoots = process.env.OMP_WEB_ALLOWED_ROOTS;
  if (!envRoots) return [];
  return envRoots.split(",").map((raw) => normalizeSlashes(raw.trim())).filter(Boolean);
}

/**
 * Roots granted on top of the session-derived ones, for one identity.
 *
 * Without an identity this is empty, and that is the point: a caller that
 * forgot to thread the identity through must fail closed. A default of "the
 * service's own account" would hand every unmigrated route the operator's
 * projects to every logged-in user, which is precisely the bug this rewrite
 * exists to remove.
 *
 * Every identity also gets its own home. Without it a tenant who has not
 * started a session yet could not open anything at all, and the home is the one
 * directory that is his by definition.
 *
 * Admins additionally get `/` and `OMP_WEB_ALLOWED_ROOTS`:
 *
 * - `/` is here for navigation, not for access. It is *not* safe by accident of
 *   the OS: the service runs as one account, so the kernel only ever sees that
 *   account and will happily hand over every file it can read. A root of `/`
 *   makes `isPathWithinRoots` return true for every absolute path, which means
 *   the allowlist is not narrowing anything at all. (Verified against the real
 *   function: with `{"/"}` it accepts `/etc/passwd` and `/proc/self/environ`.)
 *   Admins keep it because they are supposed to see the machine, and they get
 *   it *as admins* — no non-admin request reaches this branch, because that
 *   branch is the only place `/` is ever added.
 * - `OMP_WEB_ALLOWED_ROOTS` because an operator set it deliberately.
 */
export function getAdditionalAllowedRoots(identity?: WebIdentity | null): Set<string> {
  if (!identity) return new Set<string>();

  const roots = new Set<string>(bucketFor(identityKey(identity)));
  roots.add(normalizeSlashes(getUserHome(identity)));
  if (identity.isAdmin) {
    roots.add("/");
    for (const root of envRoots()) roots.add(root);
    // Grants from endpoints that predate identities. An operator action stays
    // available to admins and is never handed to a tenant.
    for (const root of bucketFor(UNATTRIBUTED)) roots.add(root);
  }
  return roots;
}

/**
 * Make `root` browsable for `identity`.
 *
 * With an identity the grant is private to that account. Without one it lands in
 * the unclaimed bucket, which only admins can see — so a route that has not
 * been migrated yet still works for the operator without giving its result to a
 * tenant.
 */
export function allowFileRoot(root: string, identity?: WebIdentity | null): void {
  if (!root) return;
  bucketFor(identityKey(identity)).add(normalizeSlashes(root));
  // Invalidate rather than patch: the cached set was assembled for one
  // identity and may have been filtered by it, so splicing a path into it could
  // cross the home boundary that assembly applied.
  if (globalThis.__ompAllowedRootsCache) {
    for (const key of globalThis.__ompAllowedRootsCache.keys()) globalThis.__ompAllowedRootsCache.delete(key);
  }
}

export function getAllowedRootsCache(): Map<string, { roots: Set<string>; expiresAt: number }> {
  if (!globalThis.__ompAllowedRootsCache) {
    globalThis.__ompAllowedRootsCache = new Map<string, { roots: Set<string>; expiresAt: number }>();
  }
  return globalThis.__ompAllowedRootsCache;
}

/** Drop cached sets. Exported for tests and for the identity of a request changing. */
export function clearAllowedRootsCache(): void {
  globalThis.__ompAllowedRootsCache?.clear();
}
