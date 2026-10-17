import { clearSessionContinuation } from "./workspace-memory";

// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && (error.code === "prompt_rejected" || error.code === "runtime_expired")
    && error.accepted === false;
}

export interface SessionIdentity {
  sessionId: string;
  runtimeId: string | null;
}

export interface RuntimeSessionBinding {
  current: string | null;
  onIdentity?: (identity: SessionIdentity, request: SessionIdentity) => boolean | void;
}

/** Accept a response only while its request still owns the selected identity. */
export function canApplySessionIdentity(current: SessionIdentity, identity: SessionIdentity, request: SessionIdentity): boolean {
  return (current.sessionId === identity.sessionId && current.runtimeId === identity.runtimeId)
    || (current.runtimeId === request.runtimeId
      && (current.sessionId === request.sessionId || current.sessionId === identity.sessionId));
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  runtime?: RuntimeSessionBinding,
): Promise<T> {
  const runtimeId = runtime?.current ?? null;
  const request = { sessionId, runtimeId };
  const res = await fetch(`/api/agent/${encodeURIComponent(runtimeId ?? sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
    sessionId?: string;
    runtimeId?: string;
  };
  if (!res.ok || body.error) {
    // Retry only when the server guarantees that the expired handle executed nothing.
    if (runtimeId && runtime?.current === runtimeId && res.status === 404
      && body.code === "runtime_expired" && body.accepted === false && body.sessionId) {
      if (runtime.onIdentity?.({ sessionId: body.sessionId, runtimeId: null }, request) !== false) {
        runtime.current = null;
        clearSessionContinuation(undefined, runtimeId);
        return sendAgentCommand<T>(body.sessionId, command, runtime);
      }
    }
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  if (runtime && runtime.current === runtimeId && body.sessionId && body.runtimeId) {
    const identity = { sessionId: body.sessionId, runtimeId: body.runtimeId };
    if (runtime.onIdentity?.(identity, request) !== false) runtime.current = body.runtimeId;
  }
  return body.data as T;
}
