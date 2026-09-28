import { NextRequest, NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  const manager = getTerminalManager();
  const info = manager.get(id);
  if (!info) return NextResponse.json({ error: "Unknown terminal" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cols = Number((body as { cols?: unknown })?.cols);
  const rows = Number((body as { rows?: unknown })?.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return NextResponse.json({ error: "cols and rows must be numbers" }, { status: 400 });
  }

  await manager.resize(id, cols, rows);
  return NextResponse.json({ ok: true });
}
