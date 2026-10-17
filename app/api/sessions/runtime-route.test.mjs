import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionContext } = await jiti.import("./[id]/context/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { GET: getAgentState } = await jiti.import("../agent/[id]/route.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? (?:await )?SessionManager\.open/);
  }
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const previousFinalIds = globalThis.__ompFinalSessionIds;
  const id = "live-route-test";
  const runtimeId = "live-route-after-fallback";
  const handle = "runtime:live-route";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__ompSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: runtimeId,
    runtimeId: handle,
    syncSessionIdentity: () => {},
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    globalThis.__ompFinalSessionIds = previousFinalIds;
  });

  const routeContext = { params: Promise.resolve({ id: handle }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`, { headers: { host: "localhost" } }),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`, { headers: { host: "localhost" } }),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.sessionId, runtimeId);
  assert.equal(detail.runtimeId, handle);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });

  globalThis.__ompFinalSessionIds = new Map([["runtime:expired-context", runtimeId]]);
  const contextResponse = await getSessionContext(new Request("http://localhost/api/sessions/runtime:expired-context/context"), {
    params: Promise.resolve({ id: "runtime:expired-context" }),
  });
  const context = await contextResponse.json();
  assert.equal(contextResponse.status, 200);
  assert.equal(context.sessionId, runtimeId);
  assert.equal(context.runtimeId, handle);
  assert.deepEqual(context.context.messages.map((message) => message.content), ["hello live"]);
});


test("an expired runtime reports a reopened canonical session's live state", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const previousFinalIds = globalThis.__ompFinalSessionIds;
  const state = { sessionId: "reopened-b", runtimeId: "runtime:new", isStreaming: true };
  globalThis.__ompFinalSessionIds = new Map([["runtime:old", state.sessionId]]);
  globalThis.__ompSessions = new Map([[state.sessionId, {
    sessionId: state.sessionId,
    runtimeId: state.runtimeId,
    isAlive: () => true,
    syncSessionIdentity: () => {},
    send: async (command) => { assert.equal(command.type, "get_state"); return state; },
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
    globalThis.__ompFinalSessionIds = previousFinalIds;
  });
  const response = await getAgentState(new Request("http://localhost/api/agent/runtime:old"), {
    params: Promise.resolve({ id: "runtime:old" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { running: true, state });
});
