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
import path from "path";
import os from "os";

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
  };
}

export async function GET() {
  const list = getTerminalManager().list().map(toInfo);
  return NextResponse.json({ terminals: list });
}

export async function POST(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json().catch(() => null) as SpawnBody | null;
    const requestedCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
      ? body.cwd
      : os.homedir();
    const cwd = path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(requestedCwd);

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied for requested cwd" }, { status: 403 });
    }

    const cols = Number.isFinite(body?.cols) ? Math.max(2, Math.min(500, Number(body?.cols))) : 80;
    const rows = Number.isFinite(body?.rows) ? Math.max(1, Math.min(200, Number(body?.rows))) : 24;

    const info = await getTerminalManager().spawn(cwd, cols, rows);
    return NextResponse.json({ terminal: toInfo(info) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
