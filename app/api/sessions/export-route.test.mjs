import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getExport } = await jiti.import("./[id]/export/route.ts");

function exportFixture(t) {
  const stateKeys = [
    "__ompSessions", "__ompFinalSessionIds", "__ompSessionPathCache",
    "__ompPathToSessionIdCache", "__ompSessionListCache",
  ];
  const previousState = stateKeys.map((key) => [key, globalThis[key]]);
  const dir = mkdtempSync(join(tmpdir(), "omp-web-export-test-"));
  const a = "export-history-a";
  const b = "export-current-b";
  const runtimeId = "runtime:export-r";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const paths = new Map();
  for (const id of [a, b]) {
    const path = join(dir, `${id}.jsonl`);
    paths.set(id, path);
    writeFileSync(path, [
      { type: "session", version: 3, id, timestamp, cwd: dir },
      {
        type: "message", id: "u1", parentId: null, timestamp,
        message: { role: "user", content: `transcript ${id}` },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  globalThis.__ompSessions = new Map([[a, {
    sessionId: b,
    runtimeId,
    sessionFile: paths.get(b),
    isAlive: () => true,
    syncSessionIdentity: () => {},
  }]]);
  globalThis.__ompFinalSessionIds = new Map();
  globalThis.__ompSessionPathCache = new Map(paths);
  globalThis.__ompPathToSessionIdCache = new Map([...paths].map(([id, path]) => [path, id]));
  // Missing files must not scan the user's session directory.
  globalThis.__ompSessionListCache = { data: [], ts: Date.now() };
  t.after(() => {
    for (const [key, value] of previousState) globalThis[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { a, b, runtimeId, paths };
}

function requestExport(id, headers = { host: "localhost" }) {
  return getExport(
    new Request(`http://localhost/api/sessions/${encodeURIComponent(id)}/export?inline=1`, { headers }),
    { params: Promise.resolve({ id }) },
  );
}

async function assertTranscript(response, id) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("Content-Disposition"), /^inline;/);
  const html = await response.text();
  const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
  assert.ok(encoded, "export contains the SDK's embedded transcript");
  const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(data.header.id, id);
  assert.deepEqual(data.entries.map((entry) => entry.message?.content), [`transcript ${id}`]);
}

test("export follows a live runtime to its current transcript after a missed identity update", async (t) => {
  const { runtimeId, b } = exportFixture(t);
  await assertTranscript(await requestExport(runtimeId), b);
});

test("export follows a destroyed runtime's final identity", async (t) => {
  const { runtimeId, b } = exportFixture(t);
  globalThis.__ompSessions.clear();
  globalThis.__ompFinalSessionIds.set(runtimeId, b);
  await assertTranscript(await requestExport(runtimeId), b);
});

test("exporting a historical ID still returns its original transcript", async (t) => {
  const { a } = exportFixture(t);
  await assertTranscript(await requestExport(a), a);
});

test("unknown runtime handles cannot be treated as historical file IDs", async (t) => {
  const { a, paths } = exportFixture(t);
  globalThis.__ompSessionPathCache.set("runtime:unknown", paths.get(a));
  const response = await requestExport("runtime:unknown");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

for (const alive of [true, false]) {
  test(`export never falls back to the old file when the ${alive ? "live" : "destroyed"} runtime's current file is missing`, async (t) => {
    const { runtimeId, a, b, paths } = exportFixture(t);
    if (!alive) {
      globalThis.__ompSessions.clear();
      globalThis.__ompFinalSessionIds.set(runtimeId, b);
    }
    globalThis.__ompSessionPathCache.set(runtimeId, paths.get(a));
    rmSync(paths.get(b));
    const response = await requestExport(runtimeId);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Session not found" });
  });
}

test("export rejects untrusted requests before accessing the runtime registry", async (t) => {
  const { runtimeId } = exportFixture(t);
  globalThis.__ompSessions.values().next().value.syncSessionIdentity = () => {
    assert.fail("untrusted request must not access runtimes");
  };
  const response = await requestExport(runtimeId, { host: "untrusted.invalid" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
});
