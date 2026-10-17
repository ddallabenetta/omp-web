import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, getRpcSession, getRpcSessionInfos, getRpcSessionActivitySnapshot, getFinalRpcSessionId, startRpcSession } = await jiti.import("./rpc-manager.ts");

function makeRuntimeSession({ id, filePath, running, entries }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  const manager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp/runtime-cwd", timestamp }),
    getEntries: () => entries,
    getSessionFile: () => filePath,
    getSessionName: () => undefined,
  };
  return {
    isAlive: () => true,
    isRunning: () => running,
    inner: { sessionManager: manager },
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

test("lists an accepted new prompt before its session file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const timestamp = "2026-08-12T01:02:04.000Z";
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: join(tmpdir(), "pi-web-missing-runtime-session.jsonl"),
    running: true,
    entries: [{
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }, { type: "text", text: "prompt" }],
      },
    }],
  });
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    entries: [],
  });
  globalThis.__ompSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "visible-runtime");
  assert.equal(infos[0].firstMessage, "first prompt");
  assert.equal(infos[0].messageCount, 1);
  assert.equal(infos[0].transient, true);
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__ompSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    entries: [],
  })]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
});

test("moves a live wrapper across successive IDs without redirecting historical sessions", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const previousFinalIds = globalThis.__ompFinalSessionIds;
  globalThis.__ompFinalSessionIds = new Map();
  const inner = { sessionId: "original-session", isBashRunning: false };
  const eventBus = { on: () => () => {} };
  const wrapper = new AgentSessionWrapper(inner, eventBus);
  const events = [];
  const disconnect = wrapper.onEvent((event) => events.push(event));
  const runtimeId = wrapper.runtimeId;
  let running = true;
  wrapper.isRunning = () => running;
  let historical;
  globalThis.__ompSessions = new Map([[inner.sessionId, wrapper]]);
  t.after(() => {
    wrapper.destroy();
    historical?.destroy();
    globalThis.__ompSessions = previousRegistry;
    globalThis.__ompFinalSessionIds = previousFinalIds;
  });

  assert.deepEqual(getRpcSessionActivitySnapshot(), {
    runningSessionIds: ["original-session"],
    sessionIdsByRuntimeId: { [runtimeId]: "original-session" },
  });
  inner.sessionId = "fallback-session";
  assert.deepEqual(getRpcSessionActivitySnapshot(), {
    runningSessionIds: ["fallback-session"],
    sessionIdsByRuntimeId: { [runtimeId]: "fallback-session" },
  });
  running = false;
  assert.deepEqual(getRpcSessionActivitySnapshot(), {
    runningSessionIds: [],
    sessionIdsByRuntimeId: { [runtimeId]: "fallback-session" },
  });
  running = true;
  assert.equal(getRpcSession(inner.sessionId), wrapper);
  assert.equal(getRpcSession("original-session"), undefined);
  assert.equal(getRpcSession(inner.sessionId), wrapper);
  assert.deepEqual([...globalThis.__ompSessions.keys()], [inner.sessionId]);
  // Reusing the current ID must not create a second agent or open a transcript.
  const resumed = await startRpcSession(inner.sessionId, "/missing/session.jsonl", undefined);
  assert.equal(resumed.session, wrapper);
  assert.equal(resumed.realSessionId, inner.sessionId);

  inner.sessionId = "second-fallback-session";
  assert.equal(getRpcSession("fallback-session"), undefined);
  assert.equal(getRpcSession("fallback-session"), undefined);
  assert.equal(getRpcSession("original-session"), undefined);
  assert.equal(getRpcSession(inner.sessionId), wrapper);
  assert.deepEqual([...globalThis.__ompSessions.keys()], [inner.sessionId]);

  // A second tab reopening B gets its own wrapper, not C's transcript.
  historical = new AgentSessionWrapper({ sessionId: "fallback-session", isBashRunning: false }, eventBus);
  globalThis.__ompSessions.set(historical.sessionId, historical);
  assert.equal(getRpcSession("fallback-session"), historical);
  const reopened = await startRpcSession("fallback-session", "/missing/session.jsonl", undefined);
  assert.equal(reopened.session, historical);
  assert.equal(reopened.realSessionId, "fallback-session");

  assert.deepEqual(events.filter((event) => event.type === "session_changed"), [
    { type: "session_changed", sessionId: "fallback-session", runtimeId },
    { type: "session_changed", sessionId: "second-fallback-session", runtimeId },
  ]);
  // A disconnected tab can recover the next identity without aliasing B or C.
  disconnect();
  inner.sessionId = "disconnected-fallback-session";
  wrapper.syncSessionIdentity();
  assert.equal(getRpcSession("second-fallback-session"), undefined);
  assert.equal(getRpcSession(runtimeId), wrapper);
  assert.equal(getRpcSession(runtimeId).sessionId, inner.sessionId);
  const recovered = await startRpcSession(runtimeId, "/missing/session.jsonl", undefined);
  assert.equal(recovered.session, wrapper);
  assert.equal(recovered.realSessionId, inner.sessionId);
  assert.equal(getRpcSession("fallback-session"), historical);
  assert.equal(events.filter((event) => event.type === "session_changed").length, 2);

  wrapper.destroy();
  assert.equal(getRpcSession(runtimeId), undefined);
  assert.equal(getFinalRpcSessionId(runtimeId), inner.sessionId);
  assert.equal(getRpcSessionActivitySnapshot().sessionIdsByRuntimeId[runtimeId], inner.sessionId);
  assert.equal(getRpcSession(inner.sessionId), undefined);
  assert.equal(getRpcSession("fallback-session"), historical);
  assert.deepEqual([...globalThis.__ompSessions.keys()], ["fallback-session"]);
});


test("upgrades a retained wrapper without replacing its active SDK session", (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const previousFinalIds = globalThis.__ompFinalSessionIds;
  globalThis.__ompFinalSessionIds = new Map();
  const inner = { sessionId: "before-hmr", isStreaming: true, isBashRunning: false };
  const wrapper = new AgentSessionWrapper(inner, { on: () => () => {} });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.onDestroy(() => globalThis.__ompSessions.delete("before-hmr"));
  let reopened;
  const legacyPrototype = Object.create(AgentSessionWrapper.prototype);
  Object.defineProperty(legacyPrototype, "syncSessionIdentity", { value: undefined });
  Object.setPrototypeOf(wrapper, legacyPrototype);
  delete wrapper.runtimeId;
  globalThis.__ompSessions = new Map([[inner.sessionId, wrapper]]);
  t.after(() => {
    wrapper.destroy();
    reopened?.destroy();
    globalThis.__ompSessions = previousRegistry;
    globalThis.__ompFinalSessionIds = previousFinalIds;
  });

  inner.sessionId = "after-hmr-fallback";
  assert.equal(getRpcSession("before-hmr"), undefined);
  assert.equal(wrapper.inner, inner);
  assert.equal(wrapper.isRunning(), true);
  assert.match(wrapper.runtimeId, /^runtime:/);
  const runtimeId = wrapper.runtimeId;
  assert.equal(getRpcSession(runtimeId), wrapper);
  assert.equal(wrapper.runtimeId, runtimeId);
  // A previous identity-aware module also needs its implementation upgraded.
  Object.setPrototypeOf(wrapper, Object.create(AgentSessionWrapper.prototype));
  assert.equal(getRpcSession(runtimeId), wrapper);
  assert.equal(Object.getPrototypeOf(wrapper), AgentSessionWrapper.prototype);
  assert.equal(wrapper.runtimeId, runtimeId);
  assert.equal(getRpcSession("before-hmr"), undefined);
  assert.deepEqual(events, [{ type: "session_changed", sessionId: inner.sessionId, runtimeId }]);
  reopened = new AgentSessionWrapper({ sessionId: "before-hmr", isBashRunning: false }, { on: () => () => {} });
  globalThis.__ompSessions.set("before-hmr", reopened);
  wrapper.destroy();
  assert.equal(getRpcSession("before-hmr"), reopened);
});
