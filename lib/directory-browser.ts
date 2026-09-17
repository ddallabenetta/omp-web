import { readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (/^~[\\/]/.test(directory)) {
    const suffix = directory.slice(2).replace(/[\\/]+/g, path.sep);
    return path.resolve(homedir(), suffix);
  }

  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(directory)
    || directory.startsWith("\\\\")
    || directory.startsWith("//");
  const pathApi = isWindowsPath ? path.win32 : path;
  const launchCwd = process.env.OMP_WEB_LAUNCH_CWD;
  const baseDirectory = launchCwd ? pathApi.resolve(launchCwd) : process.cwd();
  return pathApi.resolve(baseDirectory, directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return restoreDriveRootSeparator(await realpath(normalizeDirectory(directory)));
}

/**
 * Bun's async `realpath()` drops the trailing separator on a Windows drive
 * root: `realpath("C:\\")` resolves to `"C:"`, where Node resolves to `"C:\\"`.
 * `"C:"` is a drive-relative path, so the `readdir()` that follows fails with
 * ENOENT and the directory picker cannot open a drive. The sync and callback
 * `realpath()` variants are unaffected, so this only has to patch the result
 * back into an absolute path.
 */
export function restoreDriveRootSeparator(directory: string): string {
  return /^[a-zA-Z]:$/.test(directory) ? `${directory}\\` : directory;
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
