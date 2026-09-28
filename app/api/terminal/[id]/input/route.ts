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
  if (info.status !== "running") return NextResponse.json({ error: "Terminal has exited" }, { status: 410 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const data = (body as { data?: unknown })?.data;
  if (typeof data !== "string") {
    return NextResponse.json({ error: "data must be a string" }, { status: 400 });
  }

  await manager.write(id, data);
  return NextResponse.json({ ok: true });
}
