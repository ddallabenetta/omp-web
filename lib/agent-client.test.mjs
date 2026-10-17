import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand, canApplySessionIdentity } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  const runtime = { current: "runtime:live" };
  let transportAttempts = 0;
  globalThis.fetch = async () => {
    transportAttempts += 1;
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }, runtime),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
  assert.equal(transportAttempts, 1);
  assert.equal(runtime.current, "runtime:live");
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});


test("an explicitly expired runtime retries its confirmed final session once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  const relocations = [];
  const runtime = { current: "runtime:expired", onIdentity: (identity, request) => {
    relocations.push([identity, request]);
  } };
  const command = { type: "set_model", provider: "provider", modelId: "model" };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return requests.length === 1
      ? Response.json({ error: "Runtime session expired", code: "runtime_expired", accepted: false, sessionId: "final-session" }, { status: 404 })
      : Response.json({ success: true, data: { updated: true }, sessionId: "next-session", runtimeId: "runtime:new" });
  };
  assert.deepEqual(await sendAgentCommand("canonical-session", command, runtime), { updated: true });
  assert.deepEqual(requests, [
    { url: "/api/agent/runtime%3Aexpired", body: command },
    { url: "/api/agent/final-session", body: command },
  ]);
  assert.equal(runtime.current, "runtime:new");
  assert.deepEqual(relocations, [
    [{ sessionId: "final-session", runtimeId: null }, { sessionId: "canonical-session", runtimeId: "runtime:expired" }],
    [{ sessionId: "next-session", runtimeId: "runtime:new" }, { sessionId: "final-session", runtimeId: null }],
  ]);

  requests.length = 0;
  runtime.current = "runtime:unknown";
  globalThis.fetch = async (url) => {
    requests.push(url);
    return Response.json({ error: "Runtime session expired", code: "runtime_expired", accepted: false }, { status: 404 });
  };
  await assert.rejects(sendAgentCommand("stale-session", command, runtime), isPromptRejectedError);
  assert.deepEqual(requests, ["/api/agent/runtime%3Aunknown"]);
  assert.equal(runtime.current, "runtime:unknown");
});


test("a command-created fallback binds its canonical ID and runtime", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const identities = [];
  const runtime = { current: null, onIdentity: (identity) => { identities.push(identity); } };
  globalThis.fetch = async () => Response.json({ success: true, data: [], sessionId: "fallback", runtimeId: "runtime:new" });
  assert.deepEqual(await sendAgentCommand("historical", { type: "get_tools" }, runtime), []);
  assert.equal(runtime.current, "runtime:new");
  assert.deepEqual(identities, [{ sessionId: "fallback", runtimeId: "runtime:new" }]);
});

test("delayed identity responses cannot roll a continued runtime backward", () => {
  const request = { sessionId: "a", runtimeId: "runtime:one" };
  const response = { sessionId: "b", runtimeId: "runtime:one" };
  assert.equal(canApplySessionIdentity(request, response, request), true);
  assert.equal(canApplySessionIdentity(response, response, request), true);
  assert.equal(canApplySessionIdentity({ sessionId: "c", runtimeId: "runtime:one" }, response, request), false);
  assert.equal(canApplySessionIdentity({ sessionId: "a", runtimeId: "runtime:two" }, response, request), false);
});
