import { realpathSync } from "fs";
import path from "path";
import { getUserHome, type WebIdentity } from "./request-identity";

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) return true;
  }
  return false;
}

/**
 * True when `target` is inside the home directory of `identity`.
 *
 * Pure, and deliberately so: it takes no lock, mutates no allowlist and caches
 * nothing. It is the check for callers that need to *ask* "is this mine?"
 * — validating a cwd, refusing another tenant's home — without the side effect
 * of making a path browsable. Folding that question into `allowFileRoot()`
 * turned a validation into a grant, which is how a path becomes permanently
 * allowed to whoever asks next.
 *
 * Symlinks are resolved on both sides, so a `~/link -> /etc` does not pass just
 * because the link itself lives in the home. But *only* as far as resolution is
 * possible: when the home or the target does not exist yet, `realpathSync`
 * throws, and the naive form dropped the root and answered `false` for
 * everything — including the account's own home. That is not a strict check, it
 * is a lockout: an account created but never used has no home directory, and
 * the one question it asks is refused. So an unresolvable side falls back to
 * the plain path comparison, which is what the realpath was protecting.
 *
 * The fallback is safe in the direction that matters because both sides degrade
 * the same way: a path that cannot be resolved cannot be a symlink pointing out
 * of the home, and the lexical comparison is still anchored on the home root.
 */
export function isPathInUserHome(identity: WebIdentity | null, target: string): boolean {
  if (!identity) return false;
  const home = getUserHome(identity);
  if (!home) return false;
  if (isExistingPathWithinRoots(target, new Set([home]))) return true;
  // The resolved check said no. Fall back to the lexical one only when the
  // *home* is unresolvable — an account that has never been created has no
  // directory, and refusing him his own home is a lockout, not a rule.
  //
  // The condition is deliberately about the home and not about "either side":
  // a target that does not exist is the ordinary case for a path about to be
  // created, and it is also the ordinary case for the last segment of an escape.
  // `<home>/escape -> /etc` with a non-existent `passwd` under it resolves the
  // home fine and leaves the target unresolvable, and a fallback that trusted
  // that would hand back a symlink escape for every path that is not there yet.
  if (pathExists(home)) return false;
  return isPathWithinRoots(target, new Set([home]));
}

function pathExists(candidate: string): boolean {
  try {
    realpathSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `target` is the home of *some* other account, i.e. a path inside a
 * `/home/<user>` tree that is not this requester's own.
 *
 * The check is deliberately structural rather than "ask the system": the
 * service cannot enumerate tenants reliably, and the answer only ever feeds a
 * refusal. `isPathInUserHome` is the positive test; this is the negative one,
 * for the case where a caller would otherwise have to enumerate home dirs to
 * say no.
 */
export function isForeignUserHome(identity: WebIdentity | null, target: string): boolean {
  if (!identity) return false;
  if (isPathInUserHome(identity, target)) return false;
  const resolved = (() => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  })();
  return /^\/home\/[^/]+(\/|$)/.test(resolved);
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync(root));
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
    }
  }
  return isPathWithinRoots(realTarget, realRoots);
}
