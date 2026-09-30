import { NextRequest } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { authorizeTerminalAccess, requireIdentity } from "../../owner-guard";

export const dynamic = "force-dynamic";

// SSE stream of terminal output. Each non-control event is one chunk of PTY
// data; the lifecycle emits a single {"type":"exit"} line and closes the
// stream so the client can finalise cleanly.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted request", { status: 403 });
  }
  const { id } = await params;
  // Eine fremde Shell wird nicht angehaengt, sonst liefert der Stream die
  // Ausgabe eines Prozesses, der jemand anderem gehoert — dauerhaft, ueber SSE.
  const guard = requireIdentity(req.headers);
  if (!guard.ok) return new Response("Unknown terminal", { status: 404 });
  const access = authorizeTerminalAccess(id, guard.identity);
  if (!access.ok) return new Response("Unknown terminal", { status: 404 });

  const manager = getTerminalManager();
  const info = manager.get(id);
  if (!info) {
    return new Response("Unknown terminal", { status: 404 });
  }

  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // Stream closed by client; the cancel() handler will run.
        }
      };

      send("connected", { id: info.id, cwd: info.cwd, cols: info.cols, rows: info.rows });

      // Wrap a fake writer so we can reuse attach() — it just discards the
      // payload because we already format the SSE envelope ourselves above.
      const writer = {
        write: (chunk: Uint8Array) => {
          if (closed) return Promise.resolve();
          try {
            controller.enqueue(
              encoder.encode(`event: output\ndata: ${JSON.stringify(Array.from(chunk))}\n\n`),
            );
          } catch {
            // ignore
          }
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      } as unknown as WritableStreamDefaultWriter<Uint8Array>;

      detach = manager.attach(id, writer);

      const interval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          // ignore
        }
      }, 25_000);

      const onReqAbort = () => {
        closed = true;
        clearInterval(interval);
        detach?.();
        try { controller.close(); } catch { /* ignore */ }
      };
      req.signal.addEventListener("abort", onReqAbort);
    },
    cancel() {
      closed = true;
      detach?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
