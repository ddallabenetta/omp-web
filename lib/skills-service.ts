import { readFileSync } from "fs";
import { getAgentDir, loadSkills } from "@oh-my-pi/pi-coding-agent";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { getSettingsForIdentity } from "@/lib/omp-runtime";
import type { WebIdentity } from "@/lib/request-identity";

/**
 * Skills exactly as an omp session would see them.
 *
 * `loadSkills` is the same entry point `createAgentSession` uses, so the panel
 * lists `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills
 * and `.agents/skills` with omp's own precedence and collision warnings.
 *
 * ### Lesbar fuer alle, schreibgeschuetzt fuer Nicht-Admin
 *
 * Der Skill-*Bestand* bleibt bewusst global: eine `SKILL.md` ist Code, den
 * alle brauchen, und ein Bestand, den jeder sieht und nur der Betreiber
 * aendert, ist ein gemeinsamer Bestand mit einem Verantwortlichen. Was hier
 * nicht passieren darf, ist das andere: dass ein Mandant eine fremde Skill
 * umschreibt. Diese Grenze zieht `app/api/skills/route.ts` (PATCH), nicht
 * dieses Modul — dieses Modul **liest**, und Lesen ist der gewollte Teil.
 *
 * `identity` geht hier nur in die Lock-Datei (welche Installationen *dieses*
 * Konto als die eigenen sieht) und in die Settings (welche Skill-Optionen es
 * hat). Der `agentDir` bleibt fuer die Projekt-Vertrauensabfrage der globale
 * des Prozesses, denn das Trust-Verzeichnis ist Trust ueber die Konto-Wurzel
 * hinweg derselbe Vorgang.
 */
export async function loadSkillsWithInstallInfo(
  cwd: string,
  identity: WebIdentity | null,
): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const settings = await getSettingsForIdentity(identity, cwd);
  const { skills, warnings } = await loadSkills({ cwd, ...settings.getGroup("skills") });

  const infos: SkillInfo[] = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: readDisableModelInvocation(skill.filePath),
    sourceInfo: {
      ...(skill.source ? { source: skill.source } : {}),
      ...(skill._source?.level ? { scope: skill._source.level } : {}),
    },
  }));

  return {
    skills: annotateSkillsWithInstallInfo(infos, { cwd, agentDir, identity }),
    diagnostics: warnings.map((warning) => ({
      type: "warning" as const,
      message: warning.message,
      path: warning.skillPath,
    })),
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}

/**
 * omp's `Skill` does not carry the raw frontmatter, and the toggle in the panel
 * edits exactly one key, so read it back from the file the skill came from.
 */
function readDisableModelInvocation(filePath: string): boolean {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
    return Boolean(frontmatter["disable-model-invocation"]);
  } catch {
    return false;
  }
}
