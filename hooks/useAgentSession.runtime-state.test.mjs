import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
const callbacks = new Map();
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === "useCallback") {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
  }
  ts.forEachChild(node, collect);
}
collect(ast);

// Execute the production callbacks, stripping only TypeScript syntax. Network,
// React setters and browser storage are doubles; no copy of the guard logic.
function callback(name, bindings) {
  assert.ok(callbacks.has(name), `Missing callback: ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${callbacks.get(name)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(...Object.values(bindings));
}

const response = (data) => ({ ok: true, json: async () => data });
const live = (runtimeId = "runtime:r2") => ({ sessionId: "b", runtimeId, isStreaming: true });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness() {
  const effects = [];
  const continuation = { current: { sessionId: "b", runtimeId: "runtime:r1" } };
  const bindings = {
    mountedRef: { current: true },
    sessionIdRef: { current: "b" },
    runtimeIdRef: { current: "runtime:r1" },
    identityDraftKeyRef: { current: "b" },
    contextRequestRef: { current: 0 },
    eventSourceSessionIdRef: { current: "b" },
    historyRequestRef: { current: 0 },
    contextUsageRequestIdRef: { current: 0 },
    promptRunIdRef: { current: 1 },
    bashRecoveryIdRef: { current: 0 },
    agentRunningRef: { current: true },
    bashRunningRef: { current: true },
    modelSwitchPendingRef: { current: false },
    opts: {},
    onSessionForked: (...args) => effects.push(["identity", ...args]),
    rememberSessionContinuation: (sessionId, runtimeId) => { continuation.current = { sessionId, runtimeId }; },
    clearSessionContinuation: (_sessionId, runtimeId) => {
      if (continuation.current?.runtimeId === runtimeId) continuation.current = null;
      effects.push(["clear", runtimeId]);
    },
    normalizeQueuedMessages: (queue) => queue ?? { steering: [], followUp: [] },
    mergeSubagentSnapshots: (_current, incoming) => incoming,
    finishPromptWithoutStream: async (...args) => effects.push(["finish", ...args]),
    loadSession: async (...args) => effects.push(["history", ...args]),
    dispatch: (...args) => effects.push(["dispatch", ...args]),
    delay: async () => {},
    PROMPT_SETTLE_INITIAL_DELAY_MS: 1,
    PROMPT_SETTLE_POLL_MS: 1,
    PROMPT_SETTLE_MAX_MS: 1000,
    BASH_STATE_RECONCILE_MS: 1,
  };
  for (const name of ["Loading", "Data", "ActiveLeafId", "Messages", "EntryIds", "Error",
    "ContextUsage", "CurrentModelOverride", "SystemPrompt", "ThinkingLevel", "EffectiveThinkingLevel",
    "ExtensionStatuses", "ExtensionWidgets", "QueuedMessages", "Subagents", "IsCompacting",
    "AgentPhase", "RetryInfo", "GoalStatus", "BashRunning", "PendingBash"]) {
    bindings[`set${name}`] = (...args) => effects.push([name, ...args]);
  }
  bindings.followSessionIdentity = callback("followSessionIdentity", bindings);
  bindings.followRuntimeState = callback("followRuntimeState", bindings);
  return { bindings, effects, continuation };
}

function installNewRuntime(h) {
  assert.equal(h.bindings.followRuntimeState(live(), "b", "runtime:r1"), false);
  h.effects.length = 0;
}

function assertNewRuntime(h) {
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.deepEqual(h.continuation.current, { sessionId: "b", runtimeId: "runtime:r2" });
  assert.equal(h.effects.some(([kind]) => kind === "clear" || kind === "identity"), false);
}

for (const [label, state] of [
  ["tombstone", { sessionId: "b" }],
  ["old live identity", { sessionId: "b", runtimeId: "runtime:r1" }],
  ["missing state", undefined],
]) {
  test(`rejects a superseded runtime's ${label}`, () => {
    const h = harness();
    installNewRuntime(h);
    assert.equal(h.bindings.followRuntimeState(state, "b", "runtime:r1"), true);
    assertNewRuntime(h);
  });
}

test("accepts owned expiry, reopening and same-runtime relocation", () => {
  const h = harness();
  assert.equal(h.bindings.followRuntimeState({ sessionId: "c", runtimeId: "runtime:r1" }, "b", "runtime:r1"), false);
  assert.equal(h.bindings.sessionIdRef.current, "c");
  assert.equal(h.bindings.followRuntimeState({ sessionId: "c" }, "c", "runtime:r1"), false);
  assert.equal(h.bindings.runtimeIdRef.current, null);
  assert.equal(h.continuation.current, null);
  assert.equal(h.bindings.followRuntimeState({ sessionId: "c", runtimeId: "runtime:r2" }, "c", null), false);
  assert.deepEqual(h.continuation.current, { sessionId: "c", runtimeId: "runtime:r2" });
});

test("ignores responses after unmount or another session selection", () => {
  for (const change of [(b) => { b.mountedRef.current = false; }, (b) => { b.sessionIdRef.current = "other"; }]) {
    const h = harness();
    change(h.bindings);
    assert.equal(h.bindings.followRuntimeState(live(), "b", "runtime:r1"), true);
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r1");
    assert.deepEqual(h.effects, []);
  }
});

test("mount history loading drops the entire stale state response", async () => {
  const h = harness();
  const pending = deferred();
  const requested = deferred();
  h.bindings.fetch = async (url) => {
    if (url.startsWith("/api/sessions/")) return response({
      sessionId: "b", runtimeId: "runtime:r1", leafId: null,
      context: { messages: [], entryIds: [], thinkingLevel: "off" },
    });
    assert.equal(url, "/api/agent/runtime%3Ar1");
    requested.resolve();
    return pending.promise;
  };
  const loading = callback("loadSession", h.bindings)("b", false, true);
  await requested.promise;
  installNewRuntime(h);
  pending.resolve(response({ running: false, state: { sessionId: "b" } }));
  assert.equal(await loading, null);
  assertNewRuntime(h);
  assert.deepEqual(h.effects.filter(([name]) => name !== "Loading"), []);
});

for (const name of ["reconcileAgentState", "refreshContextUsage", "handleAgentEvent"]) {
  test(`${name} ignores a delayed old-runtime state body`, async () => {
    const h = harness();
    const pending = deferred();
    const requested = deferred();
    h.bindings.fetch = async (url) => {
      assert.equal(url, "/api/agent/runtime%3Ar1");
      requested.resolve();
      // Hold json(), not just fetch(), to cover ownership across body parsing.
      return { ok: true, json: () => pending.promise };
    };
    const fn = callback(name, h.bindings);
    const result = fn(name === "handleAgentEvent" ? { type: "agent_end" } : "b");
    await requested.promise;
    installNewRuntime(h);
    pending.resolve({ running: false, state: { sessionId: "b", contextUsage: { percent: 99 } } });
    await result;
    await new Promise((resolve) => setImmediate(resolve));
    assertNewRuntime(h);
    assert.deepEqual(h.effects, []);
  });
}

test("a superseded preflight keeps the new runtime for the event handshake", async () => {
  const h = harness();
  const pending = deferred();
  h.bindings.fetch = async () => pending.promise;
  h.bindings.EventSource = { OPEN: 1 };
  h.bindings.eventSourceRef = { current: null };
  h.bindings.eventConnectionAttemptRef = { current: null };
  h.bindings.connectEvents = async (sid) => {
    h.effects.push(["connect", sid, h.bindings.runtimeIdRef.current]);
    const source = { readyState: 1 };
    h.bindings.eventSourceRef.current = source;
    return { source, status: "connected" };
  };
  const connecting = callback("ensureEventsConnected", h.bindings)("b");
  installNewRuntime(h);
  pending.resolve(response({ running: false, state: { sessionId: "b" } }));
  await connecting;
  assertNewRuntime(h);
  assert.deepEqual(h.effects, [["connect", "b", "runtime:r2"]]);
});

test("grace cleanup retries the current runtime instead of closing from a stale idle response", async () => {
  const h = harness();
  const timers = [];
  const requests = [];
  const pending = deferred();
  Object.assign(h.bindings, {
    cancelEventStreamGrace: () => {},
    eventStreamGraceActiveRef: { current: false },
    eventStreamGraceGenerationRef: { current: 1 },
    eventStreamGraceTimerRef: { current: null },
    sdkAgentActiveRef: { current: false },
    rpcPromptPendingRef: { current: false },
    setAgentRunning: () => {},
    closeEvents: () => h.effects.push(["close"]),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    EVENT_STREAM_IDLE_GRACE_MS: 30_000,
    CONTEXT_USAGE_REFRESH_MS: 1,
    fetch: async (url) => {
      requests.push(url);
      return requests.length === 1 ? pending.promise : response({ running: true, state: live() });
    },
  });
  callback("scheduleEventStreamClose", h.bindings)("b");
  timers.shift()();
  installNewRuntime(h);
  pending.resolve(response({ running: false, state: { sessionId: "b" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assertNewRuntime(h);
  assert.deepEqual(h.effects, []);
  assert.equal(timers.length, 1, "must not abandon the grace check after ignoring a response");
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assertNewRuntime(h);
  assert.deepEqual(requests, ["/api/agent/runtime%3Ar1", "/api/agent/runtime%3Ar2"]);
  assert.equal(h.effects.some(([kind]) => kind === "close"), false);
  assert.equal(h.bindings.sdkAgentActiveRef.current, true);
  assert.equal(timers.length, 0);
});

for (const name of ["waitForPromptSettlement", "waitForBashSettlement"]) {
  test(`${name} retries R2 before settling after a delayed R1 tombstone`, async () => {
    const h = harness();
    const pending = deferred();
    const requested = deferred();
    const requests = [];
    h.bindings.fetch = async (url) => {
      requests.push(url);
      if (requests.length === 1) { requested.resolve(); return pending.promise; }
      assertNewRuntime(h);
      assert.deepEqual(h.effects, []);
      return response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } });
    };
    const settling = callback(name, h.bindings)("b", 1);
    await requested.promise;
    installNewRuntime(h);
    pending.resolve(response({ running: false, state: { sessionId: "b" } }));
    await settling;
    assertNewRuntime(h);
    assert.deepEqual(requests, ["/api/agent/runtime%3Ar1", "/api/agent/runtime%3Ar2"]);
    assert.ok(h.effects.some(([kind]) => kind === (name === "waitForPromptSettlement" ? "finish" : "history")));
  });

  for (const superseded of ["unmounted", "new run"]) {
    test(`${name} drops an in-flight response when ${superseded}`, async () => {
      const h = harness();
      const pending = deferred();
      const requested = deferred();
      h.bindings.fetch = async () => { requested.resolve(); return pending.promise; };
      const settling = callback(name, h.bindings)("b", 1);
      await requested.promise;
      if (superseded === "unmounted") h.bindings.mountedRef.current = false;
      else if (name === "waitForPromptSettlement") h.bindings.promptRunIdRef.current += 1;
      else h.bindings.bashRecoveryIdRef.current += 1;
      pending.resolve(response({ running: false, state: { sessionId: "b" } }));
      await settling;
      assert.equal(h.bindings.runtimeIdRef.current, "runtime:r1");
      assert.deepEqual(h.effects, []);
    });
  }
}
