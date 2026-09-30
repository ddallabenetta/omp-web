import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity, isAdminIdentity } from "@/lib/request-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses omp's own skill discovery (the same `loadSkills` AgentSession startup
// runs), so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin
// skills, and `.agents/skills` are all included with identical precedence.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots(getRequestIdentity(req.headers));
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd, getRequestIdentity(req.headers)));
  } catch {
    return NextResponse.json({ error: "Unable to load skills" }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
//
// ### Warum das Schreibgeschuetzt ist und nicht pro Mandant getrennt
//
// Der Skill-Bestand bleibt **ein** Bestand, und das ist eine Entscheidung, kein
// Versehen: eine `SKILL.md` ist Code, den alle Mandanten brauchen, und ein
// Bestand, den jeder sieht, aber nur der Betreiber aendert, ist ein
// gemeinsamer Bestand mit einem Verantwortlichen. Waere er pro Nutzer, wuerde
// jeder Mandant einen anderen Satz Instruktionen bekommen — und der
// Aufwand, denselben Bestand N-mal zu pflegen, waere auch dann nicht zu
// rechtfertigen, wenn man die Mandantengrenze fuer sicher haelt.
//
// Der Preis dieser Entscheidung ist aber eine Grenze, die gezogen werden muss:
// wer den gemeinsamen Code liest, darf ihn nicht auch umschreiben. Ein
// Mandant, der `disable-model-invocation` in einer `SKILL.md` toggelt, schaltet
// fuer **alle** ab, ob er will oder nicht. Deshalb ist der Schreibpfad an
// `isAdminIdentity` gebunden, und zwar *vor* jeder Pfadpruefung: die
// Pfadpruefung waere hier Tautologie, denn die Admin-Pruefung entscheidet
// bereits.
//
// Fuer einen Nicht-Admin bleibt genau das uebrig, was ihm gehoert: eigene
// Skills im eigenen Projektverzeichnis (`<cwd>/.omp/skills`) ueber die
// `getAllowedFileRoots`-Pruefung, und Lesen des gemeinsamen Bestands ueber
// GET. Beides ist bereits vorhanden und muss hier nichts erfunden werden.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const identity = getRequestIdentity(req.headers);
    if (identity === null) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!isAdminIdentity(identity)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = await req.json() as { filePath?: unknown; disableModelInvocation?: unknown };
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const disableModelInvocation = body.disableModelInvocation;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (typeof disableModelInvocation !== "boolean") {
      return NextResponse.json({ error: "disableModelInvocation must be boolean" }, { status: 400 });
    }
    if (path.basename(filePath).toLowerCase() !== "skill.md") {
      return NextResponse.json({ error: "Only SKILL.md files can be changed" }, { status: 400 });
    }

    let resolvedFilePath: string;
    try {
      resolvedFilePath = realpathSync(filePath);
    } catch {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }
    if (path.basename(resolvedFilePath).toLowerCase() !== "skill.md") {
      return NextResponse.json({ error: "Only SKILL.md files can be changed" }, { status: 400 });
    }
    if (!statSync(resolvedFilePath).isFile()) {
      return NextResponse.json({ error: "file must be a regular file" }, { status: 400 });
    }

    const allowedRoots = new Set(await getAllowedFileRoots(identity));
    allowedRoots.add(getAgentDir());
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
    if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(resolvedFilePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(resolvedFilePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Unable to update skill metadata" }, { status: 500 });
  }
}
