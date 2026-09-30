import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope } from "@/lib/api-types";
import { getUserHome, type WebIdentity } from "./request-identity";

interface SkillLockEntry {
  source?: unknown;
  sourceType?: unknown;
  skillPath?: unknown;
  ref?: unknown;
  skillFolderHash?: unknown;
  computedHash?: unknown;
}

interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

interface GlobalLockPathOptions {
  homeDir?: string;
  xdgStateHome?: string;
}

interface AnnotateSkillOptions {
  cwd: string;
  agentDir: string;
  globalLockPath?: string;
  projectLockPath?: string;
  identity?: WebIdentity | null;
}

/**
 * The single global lock — kept for the process identity (an admin).
 *
 * `getGlobalSkillsLockPath` stays the *shape* function, but it is no longer
 * called without an identity. A tenant gets their own file; see
 * `getSkillsLockPathForIdentity`.
 */
export function getGlobalSkillsLockPath({
  homeDir = homedir(),
  xdgStateHome = process.env.XDG_STATE_HOME,
}: GlobalLockPathOptions = {}): string {
  return xdgStateHome
    ? join(xdgStateHome, "skills", ".skill-lock.json")
    : join(homeDir, ".agents", ".skill-lock.json");
}

/**
 * Die Lock-Datei eines Kontos.
 *
 * Ein einziger globaler Lock hiess: was Alice installiert, sperrt Bob. Der
 * Eintrag nennt Quelle, Ref und Hash — mit einem fremden Eintrag sieht Bob
 * einen Skill als installiert, den er nie geholt hat, und der Update-Pfad
 * schreibt in ein fremdes Verzeichnis. Das ist kein Bedienfehler, das ist ein
 * Mandantenleck in einer Datei, die ein Nutzer fuer sich beschreiben darf.
 *
 * Fuer einen Nicht-Admin liegt die Datei deshalb in dessen eigenem
 * `.agents`-Verzeichnis unterhalb seiner Home, mit dem Benutzernamen im Pfad.
 * Der Admin bleibt auf der globalen Datei: sein Verzeichnis ist das
 * Prozess-Verzeichnis, und die Skill-Installation schreibt ohnehin mit `npx
 * skills add -g` in genau dieses `~/.agents` — ein zweites, vom
 * Installationswerkzeug nicht beachtetes Verzeichnis wuerde jeden installierten
 * Skill als unbekannt ausweisen.
 *
 * `null` (keine Identitaet) liefert den globalen Pfad. Das ist kein
 * Rechteausweichen: die Route, die diesen Wert verwendet, muss vorher selbst
 * eine Identitaet verlangen — der Lock-Pfad allein gibt nichts frei, er sagt
 * nur, wo gelesen wird.
 */
export function getSkillsLockPathForIdentity(identity: WebIdentity | null): string {
  if (identity === null || identity.isAdmin) return getGlobalSkillsLockPath();
  return join(getUserHome(identity), ".agents", ".skill-lock.json");
}

function readSkillLock(path: string): Record<string, SkillLockEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillLockFile;
    return parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {};
  } catch {
    return {};
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function findLockEntry(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
): SkillLockEntry | undefined {
  if (entries[skillName]) return entries[skillName];
  const normalizedName = skillName.toLowerCase();
  const key = Object.keys(entries).find((name) => name.toLowerCase() === normalizedName);
  return key ? entries[key] : undefined;
}

function normalizeSource(source: string, sourceType?: string): string {
  if (sourceType !== "github") return source.replace(/\/$/, "");
  return source
    .replace(/^git\+/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function buildSkillsShUrl(source: string, skillName: string): string | undefined {
  if (!source || source.includes("://") || source.startsWith("git@")) return undefined;
  const sourcePath = source
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  if (!sourcePath) return undefined;
  return `https://skills.sh/${sourcePath}/${encodeURIComponent(skillName)}`;
}

function getInstallInfo(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
  scope: SkillInstallScope,
): SkillInstallInfo | undefined {
  const entry = findLockEntry(entries, skillName);
  if (!entry || typeof entry.source !== "string" || !entry.source.trim()) return undefined;

  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : undefined;
  const source = normalizeSource(entry.source.trim(), sourceType);
  if (!source) return undefined;
  const skillPath = typeof entry.skillPath === "string" ? entry.skillPath : undefined;
  const ref = typeof entry.ref === "string" ? entry.ref : undefined;
  const rawVersionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const versionHash = typeof rawVersionHash === "string" && rawVersionHash
    ? rawVersionHash
    : undefined;
  const isGitHubSource =
    sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(source);
  const hasComparableVersion = scope === "global" || !ref;

  return {
    package: `${source}@${skillName}`,
    scope,
    source,
    sourceType,
    skillsShUrl: sourceType === "local" ? undefined : buildSkillsShUrl(source, skillName),
    ...(skillPath && { skillPath }),
    ...(ref && { ref }),
    ...(versionHash && { versionHash }),
    canCheckForUpdates: Boolean(
      isGitHubSource && skillPath && versionHash && hasComparableVersion,
    ),
  };
}

export function annotateSkillsWithInstallInfo(
  skills: SkillInfo[],
  {
    cwd,
    agentDir,
    identity,
    globalLockPath = getSkillsLockPathForIdentity(identity ?? null),
    projectLockPath = join(cwd, "skills-lock.json"),
  }: AnnotateSkillOptions,
): SkillInfo[] {
  const globalEntries = readSkillLock(globalLockPath);
  const projectEntries = readSkillLock(projectLockPath);
  // omp reads its own `~/.omp/agent/skills` plus the Claude layout that the
  // `skills` CLI writes into; treat both as managed install roots.
  const globalSkillsRoots = [join(agentDir, "skills"), join(homedir(), ".claude", "skills")];
  const projectSkillsRoots = [join(cwd, ".omp", "skills"), join(cwd, ".claude", "skills")];

  return skills.map((skill) => {
    if (!existsSync(skill.filePath)) return skill;

    const install = globalSkillsRoots.some((root) => isWithin(skill.filePath, root))
      ? getInstallInfo(globalEntries, skill.name, "global")
      : projectSkillsRoots.some((root) => isWithin(skill.filePath, root))
        ? getInstallInfo(projectEntries, skill.name, "project")
        : undefined;

    return install ? { ...skill, install } : skill;
  });
}
