// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __ompAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __ompAdditionalAllowedRoots: Set<string> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__ompAdditionalAllowedRoots) {
    const set = new Set<string>();
    // `/` is always included so the file-explorer breadcrumb and Up button
    // can navigate to the filesystem root without extra configuration. The
    // per-path server check (`isFilePathAllowed` -> realpath symlink guard)
    // still protects individual file access, so a path can only be opened
    // when the running process actually has OS-level read permission for it.
    set.add("/");
    // Honour OMP_WEB_ALLOWED_ROOTS at startup. Comma-separated absolute
    // paths extend the set of directories the file browser can navigate
    // into beyond the omp session cwds. Useful for letting users browse
    // specific paths alongside the always-on `/`.
    const envRoots = process.env.OMP_WEB_ALLOWED_ROOTS;
    if (envRoots) {
      for (const raw of envRoots.split(",")) {
        const trimmed = raw.trim();
        if (trimmed) set.add(normalizeSlashes(trimmed));
      }
    }
    globalThis.__ompAdditionalAllowedRoots = set;
  }
  return globalThis.__ompAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__ompAllowedRootsCache?.roots.add(normalizedRoot);
}
