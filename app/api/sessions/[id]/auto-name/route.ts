import { NextResponse } from "next/server";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, getFinalRpcSessionId } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    let session = getRpcSession(id);
    if (!session?.isAlive()) {
      const canonicalId = id.startsWith("runtime:") ? getFinalRpcSessionId(id) : id;
      const filePath = canonicalId ? await resolveSessionPath(canonicalId) : undefined;
      if (!canonicalId || !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      ({ session } = await startRpcSession(canonicalId, filePath, undefined));
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // omp declines to title greetings and other low-signal openers; report that
    // as a no-op instead of writing a meaningless name.
    if (!result) {
      return NextResponse.json({ title: null, skipped: true });
    }

    await session.inner.sessionManager.setSessionName(result.title, "auto");
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, sessionId: session.sessionId, runtimeId: session.runtimeId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
