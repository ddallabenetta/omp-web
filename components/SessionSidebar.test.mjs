import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("keeps subagents out of the left session sidebar", () => {
  assert.doesNotMatch(source, /SubagentRail|SubagentPanel|subagents/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});
test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});
test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /onClick=\{\(\) => loadSessions\(false, true\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});

// Execute the actual activity effect with state/notification doubles, so these
// cases cover unread markers and completion callbacks without copying its logic.
const activityEffectStart = source.indexOf("    const previousSnapshot = previousActivitySnapshotRef.current;");
const activityEffectEnd = source.indexOf("\n  }, [activitySnapshot,", activityEffectStart);
assert.ok(activityEffectStart >= 0 && activityEffectEnd > activityEffectStart);
const runActivityEffect = new Function(
  "previousActivitySnapshotRef", "activitySnapshot", "runningSessionIds",
  "selectedSessionId", "selectedRuntimeId", "allSessions", "setUnreadSessionIds",
  "loadSessions", "onBackgroundTaskDone",
  source.slice(activityEffectStart, activityEffectEnd),
);

const snapshot = (runningSessionIds, sessionIdsByRuntimeId = {}) => ({ runningSessionIds, sessionIdsByRuntimeId });
const activityCases = [
  {
    name: "does not report selected runtime completion when restart loses its relocated identity",
    previous: snapshot(["a"], { "runtime:selected": "a" }),
    current: snapshot([]),
    selectedSessionId: "b", selectedRuntimeId: "runtime:selected",
    expectedUnread: [],
  },
  {
    name: "still reports another runtime completing in the same restart snapshot",
    previous: snapshot(["a", "other"], { "runtime:selected": "a", "runtime:other": "other" }),
    current: snapshot([]),
    selectedSessionId: "b", selectedRuntimeId: "runtime:selected",
    expectedUnread: ["other"],
  },
  {
    name: "does not suppress background completion when both runtime IDs are absent",
    previous: snapshot(["a"]),
    current: snapshot([]),
    selectedSessionId: "b",
    expectedUnread: ["a"],
  },
  {
    name: "keeps ordinary selected transcript completion out of background notifications",
    previous: snapshot(["a"]),
    current: snapshot([]),
    selectedSessionId: "a",
    expectedUnread: [],
  },
  {
    name: "matches selected completion through the current runtime mapping",
    previous: snapshot(["a"], { "runtime:selected": "a" }),
    current: snapshot([], { "runtime:selected": "b" }),
    selectedSessionId: "a", selectedRuntimeId: "runtime:selected",
    expectedUnread: [],
  },
  {
    name: "does not complete a relocated runtime that is still running",
    previous: snapshot(["a"], { "runtime:other": "a" }),
    current: snapshot(["b"], { "runtime:other": "b" }),
    selectedSessionId: "selected", selectedRuntimeId: "runtime:selected",
    initialUnread: ["b"], expectedUnread: [],
  },
  {
    name: "marks the current transcript unread when a background runtime finishes",
    previous: snapshot(["a"], { "runtime:other": "a" }),
    current: snapshot([], { "runtime:other": "b" }),
    selectedSessionId: "selected", selectedRuntimeId: "runtime:selected",
    expectedUnread: ["b"],
  },
];

for (const scenario of activityCases) {
  test(scenario.name, () => {
    const previousRef = { current: scenario.previous };
    let unread = new Set(scenario.initialUnread ?? []);
    let completionCount = 0;
    const refreshes = [];
    runActivityEffect(
      previousRef, scenario.current, new Set(scenario.current.runningSessionIds),
      scenario.selectedSessionId, scenario.selectedRuntimeId,
      ["a", "b", "other", "selected"].map((id) => ({ id })),
      (update) => { unread = update(unread); },
      (...args) => { refreshes.push(args); },
      () => { completionCount += 1; },
    );
    assert.deepEqual([...unread], scenario.expectedUnread);
    const completed = scenario.expectedUnread.length > 0;
    assert.equal(completionCount, completed ? 1 : 0);
    assert.deepEqual(refreshes, completed ? [[false, true]] : []);
    assert.equal(previousRef.current, scenario.current);
  });
}
