import {
  getRunningRpcSessionIds,
  subscribeRunningSessions,
} from "@/lib/rpc-manager";
import { getRequestIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  // Der Broadcast ist ein Prozessereignis und traegt alle Ids. Ohne Identitaet
  // wird daraus nichts gesendet: ein 403 ist die Antwort, nicht ein leerer
  // Strom, denn ein leerer Strom sieht fuer den Client aus wie "nichts laeuft".
  const identity = getRequestIdentity(req.headers);
  if (!identity) {
    return new Response("Unknown user", { status: 403 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      // Der Broadcast feuert fuer JEDE Zustandsaenderung im Prozess, auch fuer
      // die einer fremden Session. Der Abonnent filtert deshalb selbst: was der
      // eine als fremd sieht, ist beim Admin seine eigene, und das laesst sich
      // nicht im Broadcast entscheiden.
      const unsubscribe = subscribeRunningSessions(() => {
        try {
          encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(identity) });
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(identity) });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
