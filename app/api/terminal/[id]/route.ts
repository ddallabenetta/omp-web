import { NextRequest, NextResponse } from "next/server";
import { getTerminalManager, type TerminalInfo } from "@/lib/terminal-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { authorizeTerminalAccess, requireIdentity } from "../owner-guard";

export const dynamic = "force-dynamic";

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
    // Siehe die gleichnamige Stelle in `app/api/terminal/route.ts`: die
    // Serialisierung ist eine Kopie, und beide muessen dasselbe sagen.
    sandboxed: info.sandboxed,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = requireIdentity(req.headers);
  if (!guard.ok) return guard.response;
  const access = authorizeTerminalAccess(id, guard.identity);
  if (!access.ok) return access.response;

  const info = getTerminalManager().get(id);
  if (!info) return NextResponse.json({ error: "Unknown terminal" }, { status: 404 });
  return NextResponse.json({ terminal: toInfo(info) });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const guard = requireIdentity(req.headers);
  if (!guard.ok) return guard.response;
  const access = authorizeTerminalAccess(id, guard.identity);
  if (!access.ok) return access.response;

  const manager = getTerminalManager();
  const info = manager.get(id);
  if (!info) return NextResponse.json({ ok: true, alreadyGone: true });
  await manager.kill(id);
  return NextResponse.json({ ok: true });
}
