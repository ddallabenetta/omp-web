import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const handleViewFullHistory = useCallback");
const end = source.indexOf("\n  }, [selectedSession]);", start);
assert.ok(start >= 0 && end > start, "History callback not found");
// Execute the production callback with a window double, rather than duplicating
// its URL selection logic in the test.
const createHistoryCallback = new Function(
  "selectedSession", "window", "useCallback",
  `${source.slice(start, end + "\n  }, [selectedSession]);".length)}\nreturn handleViewFullHistory;`,
);

for (const { name, selectedSession, expectedId } of [
  {
    name: "History follows the selected runtime after a missed identity update",
    selectedSession: { id: "history-a", runtimeId: "runtime:history-r" },
    expectedId: "runtime:history-r",
  },
  {
    name: "History preserves historical session IDs without a runtime handle",
    selectedSession: { id: "history-a" },
    expectedId: "history-a",
  },
  {
    name: "History does nothing without a selected session",
    selectedSession: null,
  },
]) {
  test(name, () => {
    const opened = [];
    const callback = createHistoryCallback(
      selectedSession,
      { open: (...args) => opened.push(args) },
      (callback) => callback,
    );
    callback();
    assert.deepEqual(opened, expectedId ? [[
      `/api/sessions/${encodeURIComponent(expectedId)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    ]] : []);
  });
}
