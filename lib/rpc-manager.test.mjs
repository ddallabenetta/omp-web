import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const { AgentSessionWrapper, resolveForkEntryId } = await loadSubject();

function makeEventBus() {
  return { on: () => () => {} };
}

function makeInner(overrides = {}) {
  return Object.assign({
    sessionId: "old-session",
    sessionFile: "/tmp/omp-web-old-session.jsonl",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    configuredThinkingLevel: () => undefined,
    model: undefined,
    agent: { state: {} },
    extensionRunner: undefined,
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    compact: async () => {},
    abortCompaction: () => {},
  }, overrides);
}

test("RPC session startup reuses the shared omp runtime instead of a per-session one", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /getOmpRuntime\(\)/);
  assert.match(startupSource, /getSettingsForCwd\(sessionCwd\)/);
  assert.match(startupSource, /modelRegistry,/);
});

test("RPC session startup gates untrusted project code before creating the session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const discoverIndex = startupSource.indexOf("discoverSessionExtensionPaths(");
  const gateIndex = startupSource.indexOf("untrustedProjectSessionOptions(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(discoverIndex >= 0);
  assert.ok(gateIndex > discoverIndex);
  assert.ok(createIndex > gateIndex);
  assert.match(startupSource, /discoverCustomToolPaths\(\[\], sessionCwd\)/);
  assert.match(startupSource, /\.\.\.\(untrusted \?\? \{\}\)/);
});

test("RPC session startup applies SYSTEM.md / APPEND_SYSTEM.md to the session options", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveSessionSystemPrompts(sessionCwd)");
  const applyIndex = startupSource.indexOf("applyResolvedSystemPromptInputs(");
  const createIndex = startupSource.indexOf("createAgentSession(sessionOptions)");

  assert.ok(resolveIndex >= 0);
  assert.ok(applyIndex > resolveIndex);
  assert.ok(createIndex > applyIndex);
  assert.match(
    startupSource,
    /applyResolvedSystemPromptInputs\(sessionOptions, systemPrompts\.systemPrompt, systemPrompts\.appendPrompt\)/,
  );
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.buildSessionContext\(\)\.messages\.length > 0/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /untrustedProjectSessionOptions\(sessionCwd, agentDir, \{ extensionPaths, customToolPaths \}\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /await this\.shutdownAfterCommittedFork\(newSessionId\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(\s*runtime\.settings/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("RPC command bridge dispatches omp text-mode slash builtins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const commandSource = source.slice(
    source.indexOf('case "execute_slash_command"'),
    source.indexOf('case "set_tools"'),
  );

  assert.match(commandSource, /executeAcpBuiltinSlashCommand\(/);
  assert.match(commandSource, /output\.push\(text\)/);
  assert.match(commandSource, /handled: true/);
  assert.match(commandSource, /prompt: result\.prompt/);
});
test("RPC state retains completed subagent snapshots for history", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "get_subagent_messages"'),
  );

  assert.match(source, /private readonly subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(source, /private getSubagentSnapshots\(\)/);
  assert.match(stateSource, /subagents: this\.getSubagentSnapshots\(\)/);
  assert.match(source, /this\.subagentHistory\.clear\(\)/);
  assert.match(source, /this\.subagents\.getSubagents\(\)\.length > 0/);
});

test("latest-session fork resolution is atomic and preserves explicit tree targets", () => {
  const branch = [
    { id: "user-old", type: "message", message: { role: "user" } },
    { id: "assistant", type: "message", message: { role: "assistant" } },
    { id: "custom", type: "custom" },
    { id: "user-latest", type: "message", message: { role: "user" } },
  ];

  assert.equal(resolveForkEntryId(branch), "user-latest");
  assert.equal(resolveForkEntryId(branch, "explicit-entry"), "explicit-entry");
  assert.equal(resolveForkEntryId([{ id: "assistant", type: "message", message: { role: "assistant" } }]), undefined);
});

test("RPC handoff reports distinct running state and rejects concurrent mutations", async () => {
  let finishHandoff;
  const inner = makeInner({
    compact: () => new Promise((_resolve, reject) => {
      finishHandoff = () => reject(new CompactionCancelledError());
    }),
    abortCompaction: () => finishHandoff(),
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());
  const handoff = wrapper.send({ type: "handoff", customInstructions: "focus" });
  await Promise.resolve();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isHandoffRunning, true);
  assert.equal(state.isCompacting, false);
  await assert.rejects(
    wrapper.send({ type: "fork" }),
    /Cannot modify the session while a handoff is in progress/,
  );
  await assert.rejects(
    wrapper.send({ type: "handoff" }),
    /Cannot modify the session while a handoff is in progress/,
  );

  await wrapper.send({ type: "abort_compaction" });
  assert.deepEqual(await handoff, { cancelled: true });
  assert.equal((await wrapper.send({ type: "get_state" })).isHandoffRunning, false);
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC handoff compacts in place and keeps the session serving", async () => {
  let receivedInstructions;
  let receivedOptions;
  const inner = makeInner({
    compact: async (instructions, options) => {
      receivedInstructions = instructions;
      receivedOptions = options;
    },
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());

  assert.deepEqual(
    await wrapper.send({ type: "handoff", customInstructions: "focus exactly here" }),
    { cancelled: false },
  );

  assert.equal(receivedInstructions, "focus exactly here");
  assert.deepEqual(receivedOptions, { mode: "handoff" });
  assert.equal(inner.sessionId, "old-session");
  assert.equal(inner.sessionFile, "/tmp/omp-web-old-session.jsonl");
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC handoff surfaces compaction failures and clears busy state", async () => {
  const inner = makeInner({
    compact: async () => { throw new Error("summary provider failed"); },
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());
  await assert.rejects(wrapper.send({ type: "handoff" }), /summary provider failed/);
  assert.equal((await wrapper.send({ type: "get_state" })).isHandoffRunning, false);
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC tools keep bash-mounted MCP commands enabled without declaring them at the top level", async (t) => {
  const descriptions = {
    bash: "Run commands",
    mcp__fixture__record: "Record a note",
    read: "Read files",
  };
  const inner = makeInner({
    getAllToolNames: () => Object.keys(descriptions),
    getToolByName: (name) => ({ name, description: descriptions[name] }),
    getActiveToolNames: () => ["bash"],
    getEnabledToolNames: () => ["bash", "mcp__fixture__record"],
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());
  t.after(() => wrapper.destroy());

  assert.deepEqual(await wrapper.send({ type: "get_tools" }), [
    { name: "bash", description: descriptions.bash, active: true },
    {
      name: "mcp__fixture__record",
      description: descriptions.mcp__fixture__record,
      active: true,
      declarationHidden: true,
    },
    { name: "read", description: descriptions.read, active: false },
  ]);
});
