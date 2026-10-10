import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/**
 * Request-body ceiling this route accepts, matching
 * `experimental.proxyClientMaxBodySize` in `next.config.ts`. Kept slightly
 * under the Next limit so the handler answers with a reason instead of the
 * proxy dropping the connection.
 */
const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;

/** Trusted Content-Length, or null when absent or not a plain integer. */
function declaredBodyLength(req: Request): number | null {
  const header = req.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  // `proxy.ts` matches this route and refuses oversized bodies at the Next
  // limit, which reaches the client as a bare 413 with no explanation. This
  // guard runs first, so an over-budget prompt gets the same `prompt_rejected`
  // shape the client already knows how to react to — with a reason it can
  // show. It only reads Content-Length; chunked requests still fall through to
  // the proxy, and `validateAgentImages` re-checks the decoded sizes either way.
  const declaredLength = declaredBodyLength(req);
  if (declaredLength !== null && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return NextResponse.json({
      error: `Request body is too large (${Math.round(declaredLength / (1024 * 1024))}MB); attach fewer or smaller images`,
      code: "prompt_rejected",
      accepted: false,
    }, { status: 413 });
  }

  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
