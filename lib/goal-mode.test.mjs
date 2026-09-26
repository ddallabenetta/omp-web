import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";

async function loadSubject() {
  return import("./goal-mode.ts");
}

function makeGoal(overrides = {}) {
  return {
    id: "goal-1",
    objective: "ship the release",
    status: "active",
    tokensUsed: 1200,
    timeUsedSeconds: 90,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** A stand-in for the SDK session, driving the same GoalRuntime call shapes. */
function makeSession(options = {}) {
  const entries = options.entries ?? [];
  const settings = Settings.isolated({
    "goal.enabled": true,
    "goal.continuationModes": ["interactive"],
    ...options.settings,
  });
  let state = options.state;
  const calls = { tools: [], modeChanges: [], customEntries: [], goalContext: 0 };
  let tools = options.tools ?? ["read", "bash"];

  const session = {
    isStreaming: options.isStreaming ?? false,
    calls,
    get toolNames() { return tools; },
    settings,
    sessionManager: {
      getEntries: () => entries,
      appendModeChange: (mode, data) => calls.modeChanges.push({ mode, data }),
      appendCustomEntry: (type, data) => calls.customEntries.push({ type, data }),
    },
    getGoalModeState: () => state,
    setGoalModeState: (next) => { state = next; },
    getEnabledToolNames: () => tools,
    setActiveToolsByName: async (names) => { tools = names; calls.tools.push(names); },
    sendGoalModeContext: async () => { calls.goalContext += 1; },
    getPlanModeState: () => options.planMode,
    goalRuntime: {
      createGoal: async ({ objective }) => {
        state = { enabled: true, mode: "active", goal: makeGoal({ objective }) };
        return state;
      },
      replaceGoal: async ({ objective }) => {
        state = { enabled: true, mode: "active", goal: makeGoal({ objective, id: "goal-2" }) };
        return state;
      },
      resumeGoal: async () => {
        state = { enabled: true, mode: "active", goal: makeGoal({ ...state?.goal, status: "active" }) };
        return state;
      },
      pauseGoal: async () => {
        state = { enabled: false, mode: "active", goal: makeGoal({ ...state?.goal, status: "paused" }) };
        return state;
      },
      dropGoal: async () => {
        const goal = state?.goal;
        state = undefined;
        return goal;
      },
      onThreadResumed: async () => {
        if (state?.goal?.status === "active") {
          state = { enabled: false, mode: "active", goal: { ...state.goal, status: "paused" } };
        }
        return state;
      },
      onBudgetMutated: async (budget) => {
        state = { enabled: true, mode: "active", goal: makeGoal({ ...state?.goal, tokenBudget: budget }) };
        return state;
      },
      buildContinuationPrompt: () => options.continuationPrompt ?? "Keep working on the goal.",
      clearAccounting: () => {},
    },
  };
  return session;
}

async function makeController(sessionOptions = {}, controllerOptions = {}) {
  const { GoalModeController } = await loadSubject();
  const session = makeSession(sessionOptions);
  const continuations = [];
  const controller = new GoalModeController(session, {
    isBusy: () => false,
    runContinuation: async (prompt) => { continuations.push(prompt); },
    continuationDelayMs: 1,
    ...controllerOptions,
  });
  return { session, controller, continuations };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("splits goal subcommands from a bare objective", async () => {
  const { parseGoalCommand } = await loadSubject();
  assert.deepEqual(parseGoalCommand("set ship the release"), { sub: "set", rest: "ship the release" });
  assert.deepEqual(parseGoalCommand("  SHOW  "), { sub: "show", rest: "" });
  assert.deepEqual(parseGoalCommand("budget 50000"), { sub: "budget", rest: "50000" });
  // A first word that is not a subcommand is the start of the objective.
  assert.deepEqual(parseGoalCommand("ship the release"), { rest: "ship the release" });
  assert.deepEqual(parseGoalCommand(""), { rest: "" });
});

test("accepts a positive integer budget or off", async () => {
  const { parseGoalBudget } = await loadSubject();
  assert.deepEqual(parseGoalBudget("50000"), { budget: 50000 });
  assert.deepEqual(parseGoalBudget(" OFF "), {});
  for (const bad of ["0", "-5", "12.5", "abc", "50k", ""]) {
    assert.ok(parseGoalBudget(bad).error, `expected ${bad} to be rejected`);
  }
});

test("continues only for run modes named in the setting", async () => {
  const { isGoalContinuationEnabled } = await loadSubject();
  assert.equal(isGoalContinuationEnabled(["interactive"]), true);
  assert.equal(isGoalContinuationEnabled(["web"]), true);
  assert.equal(isGoalContinuationEnabled(["print"]), false);
  assert.equal(isGoalContinuationEnabled([]), false);
  assert.equal(isGoalContinuationEnabled(undefined), false);
});

test("rebuilds a goal from a persisted mode_change, rejecting partial records", async () => {
  const { goalFromModeData } = await loadSubject();
  const goal = makeGoal();
  assert.deepEqual(goalFromModeData({ goal }), { ...goal, tokenBudget: undefined });
  assert.equal(goalFromModeData({ goal: { ...goal, tokensUsed: undefined } }), undefined);
  assert.equal(goalFromModeData({}), undefined);
  assert.equal(goalFromModeData(undefined), undefined);
});

test("starting a goal enables the goal tool and submits the objective", async () => {
  const { controller, session } = await makeController();
  const result = await controller.handleCommand("ship the release");

  assert.equal(result.error, undefined);
  assert.equal(result.prompt, "ship the release");
  assert.deepEqual(session.toolNames, ["read", "bash", "goal"]);
  assert.equal(controller.enabled, true);
  assert.equal(controller.getStatus()?.objective, "ship the release");
});

test("refuses to start when goal mode is off or plan mode owns the session", async () => {
  const disabled = await makeController({ settings: { "goal.enabled": false } });
  assert.match((await disabled.controller.handleCommand("x")).error ?? "", /disabled/);

  const planning = await makeController({ planMode: { enabled: true } });
  assert.match((await planning.controller.handleCommand("x")).error ?? "", /plan mode/);
});

test("a bare /goal reports the current goal and refuses to replace an active one", async () => {
  const { controller } = await makeController();
  assert.match((await controller.handleCommand("")).error ?? "", /Usage/);

  await controller.handleCommand("ship the release");
  const show = await controller.handleCommand("");
  assert.match(show.message ?? "", /Objective: ship the release/);
  assert.match((await controller.handleCommand("something else")).error ?? "", /already active/);
});

test("pause restores the previous tools and resume puts the goal tool back", async () => {
  const { controller, session } = await makeController();
  await controller.handleCommand("ship the release");

  const paused = await controller.handleCommand("pause");
  assert.equal(paused.error, undefined);
  assert.deepEqual(session.toolNames, ["read", "bash"]);
  assert.equal(controller.enabled, false);

  const resumed = await controller.handleCommand("resume");
  assert.equal(resumed.error, undefined);
  assert.deepEqual(session.toolNames, ["read", "bash", "goal"]);
  assert.equal(controller.enabled, true);
});

test("drop clears the goal and validates budget input", async () => {
  const { controller } = await makeController();
  await controller.handleCommand("ship the release");

  assert.match((await controller.handleCommand("budget nope")).error ?? "", /positive integer/);
  assert.match((await controller.handleCommand("budget 50000")).message ?? "", /50,000/);

  assert.equal((await controller.handleCommand("drop")).error, undefined);
  assert.equal(controller.getStatus(), null);
  assert.match((await controller.handleCommand("drop")).error ?? "", /No goal to drop/);
});

test("continues the goal after a turn ends", async () => {
  const { controller, continuations } = await makeController();
  await controller.handleCommand("ship the release");

  await controller.handleSessionEvent({ type: "agent_start" });
  await controller.handleSessionEvent({ type: "tool_execution_start" });
  await controller.handleSessionEvent({ type: "agent_end" });
  await settle();

  assert.deepEqual(continuations, ["Keep working on the goal."]);
});

test("stops continuing once a continuation turn does no work", async () => {
  const { controller, continuations } = await makeController();
  await controller.handleCommand("ship the release");

  await controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(continuations.length, 1);

  // That continuation ran with no tool calls: the agent has nothing left to do,
  // so another identical nudge would loop forever.
  await controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(continuations.length, 1);

  // A prompt from the operator re-arms it.
  controller.onUserPrompt();
  await controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(continuations.length, 2);
});

test("does not continue while paused, while busy, or for another run mode", async () => {
  const paused = await makeController();
  await paused.controller.handleCommand("ship the release");
  await paused.controller.handleCommand("pause");
  await paused.controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(paused.continuations.length, 0);

  const busy = await makeController({}, { isBusy: () => true });
  await busy.controller.handleCommand("ship the release");
  await busy.controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(busy.continuations.length, 0);

  const otherMode = await makeController({ settings: { "goal.continuationModes": ["print"] } });
  await otherMode.controller.handleCommand("ship the release");
  await otherMode.controller.handleSessionEvent({ type: "agent_end" });
  await settle();
  assert.equal(otherMode.continuations.length, 0);
});

test("an aborted continuation does not cancel a pending one twice", async () => {
  const { controller, continuations } = await makeController();
  await controller.handleCommand("ship the release");
  await controller.handleSessionEvent({ type: "agent_end" });
  controller.onAbort();
  await settle();
  assert.equal(continuations.length, 0);
});

test("exits goal mode when the goal tool reports completion", async () => {
  const { controller, session } = await makeController();
  await controller.handleCommand("ship the release");
  session.setGoalModeState({ ...session.getGoalModeState(), mode: "exiting" });

  await controller.handleSessionEvent({ type: "agent_end" });

  assert.equal(controller.getStatus(), null);
  assert.deepEqual(session.toolNames, ["read", "bash"]);
  assert.deepEqual(session.calls.modeChanges.at(-1), { mode: "none", data: undefined });
  assert.equal(session.calls.customEntries.at(-1)?.type, "goal-completed");
});

test("restores a goal persisted by an earlier run, paused so nothing auto-starts", async () => {
  const goal = makeGoal();
  const { controller, session } = await makeController({
    entries: [
      { type: "mode_change", mode: "plan", data: {} },
      { type: "mode_change", mode: "goal", data: { goal } },
    ],
  });

  await controller.restore();

  assert.equal(controller.getStatus()?.objective, "ship the release");
  // onThreadResumed pauses a goal whose process went away.
  assert.equal(controller.enabled, false);
  assert.deepEqual(session.toolNames, ["read", "bash", "goal"]);
});

test("clears a persisted goal that cannot be rebuilt or is no longer allowed", async () => {
  const broken = await makeController({
    entries: [{ type: "mode_change", mode: "goal", data: { goal: { id: "x" } } }],
  });
  await broken.controller.restore();
  assert.equal(broken.controller.getStatus(), null);
  assert.deepEqual(broken.session.calls.modeChanges.at(-1), { mode: "none", data: undefined });

  const disabled = await makeController({
    settings: { "goal.enabled": false },
    entries: [{ type: "mode_change", mode: "goal", data: { goal: makeGoal() } }],
  });
  await disabled.controller.restore();
  assert.equal(disabled.controller.getStatus(), null);
});

test("keeps the goal tool through a tool-preset change", async () => {
  const { controller } = await makeController();
  await controller.handleCommand("ship the release");
  assert.deepEqual(controller.reconcileToolNames(["read"]), ["read", "goal"]);

  await controller.handleCommand("drop");
  assert.deepEqual(controller.reconcileToolNames(["read"]), ["read"]);
});

test("formats the same status lines the TUI prints", async () => {
  const { formatGoalStatus } = await loadSubject();
  const lines = formatGoalStatus({
    objective: "ship the release",
    status: "active",
    enabled: true,
    tokensUsed: 1200,
    tokenBudget: 5000,
    timeUsedSeconds: 90,
  }).split("\n");
  assert.equal(lines[0], "Objective: ship the release");
  assert.equal(lines[1], "Status: active");
  assert.match(lines[2], /1,200 \/ 5,000 \(3,800 left\)/);
  assert.equal(lines[3], "Time spent: 1m 30s");
});

test("restores at most once, and commands wait for it", async () => {
  const goal = makeGoal();
  const { controller, session } = await makeController({
    entries: [{ type: "mode_change", mode: "goal", data: { goal } }],
  });

  // A command that lands before the background restore settles must act on the
  // restored goal, not create a second one.
  const [, result] = await Promise.all([controller.restore(), controller.handleCommand("something else")]);
  assert.match(result.error ?? "", /Resume the current goal first/);
  assert.equal(controller.getStatus()?.objective, "ship the release");
  assert.equal(session.calls.tools.length, 1);
})
