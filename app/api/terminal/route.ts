import { NextRequest, NextResponse } from "next/server";
import {
  getTerminalManager,
  type TerminalInfo,
} from "@/lib/terminal-manager";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
} from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getUserHome, isAdminIdentity } from "@/lib/request-identity";
import { requireIdentity } from "./owner-guard";
import path from "path";

export const dynamic = "force-dynamic";

interface SpawnBody {
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
}

function toInfo(info: TerminalInfo) {
  return {
    id: info.id,
    cwd: info.cwd,
    pid: info.pid,
    status: info.status,
    exitCode: info.exitCode,
    shell: info.shell,
    cols: info.cols,
    rows: info.rows,
    createdAt: info.createdAt,
    lastActivityAt: info.lastActivityAt,
    owner: info.owner,
  };
}

export async function GET(req: NextRequest) {
  const guard = requireIdentity(req.headers);
  if (!guard.ok) return guard.response;
  const { identity } = guard;

  // Der Admin sieht alle Shells, jeder andere nur seine eigenen. Fremde
  // Shells sind nicht "ausgeblendet", sie sind in dieser Liste nicht
  // vorhanden.
  const manager = getTerminalManager();
  const list = (isAdminIdentity(identity) ? manager.listAll() : manager.listOwnedBy(identity.username)).map(toInfo);
  return NextResponse.json({ terminals: list });
}

export async function POST(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  // Eine Shell ohne Besitzer waere fuer niemanden auffindbar, also lieber keine.
  // Der Default-cwd ist die eigene Home, nicht homedir() des Prozessbenutzers.
  const guard = requireIdentity(req.headers);
  if (!guard.ok) return guard.response;
  const { identity } = guard;

  try {
    const body = await req.json().catch(() => null) as SpawnBody | null;
    const requestedCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
      ? body.cwd
      : getUserHome(identity);
    const cwd = path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(requestedCwd);

    const allowedRoots = await getAllowedFileRoots(identity);
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied for requested cwd" }, { status: 403 });
    }

    const cols = Number.isFinite(body?.cols) ? Math.max(2, Math.min(500, Number(body?.cols))) : 80;
    const rows = Number.isFinite(body?.rows) ? Math.max(1, Math.min(200, Number(body?.rows))) : 24;

    const info = await getTerminalManager().spawn(cwd, cols, rows, identity.username);
    return NextResponse.json({ terminal: toInfo(info) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
