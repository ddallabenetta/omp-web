import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeSession, GoalStatusInfo } from "./omp-types";
import { getSetting } from "@/lib/omp-settings";

export type { GoalStatusInfo } from "./omp-types";

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);

/**
 * Run modes whose name in `goal.continuationModes` enables auto-continuation
 * here. omp-web is an interactive host, so it honours the shipped default
 * (`["interactive"]`); `web` lets an operator turn continuation on for the
 * browser alone.
 */
const CONTINUATION_MODE_NAMES = ["interactive", "web"];

/** Mirrors the TUI: give the operator a moment before the next turn starts. */
export const GOAL_CONTINUATION_DELAY_MS = 800;

export interface GoalCommandResult {
  message?: string;
  error?: string;
  /** Objective to submit as a user prompt once the goal is recorded. */
  prompt?: string;
  status: GoalStatusInfo | null;
}

/** Split `/goal <sub> <rest>`; anything else is a bare objective. */
export function parseGoalCommand(args: string): { sub?: GoalSubcommand; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { rest: "" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { rest: trimmed };
  const first = match[1].toLowerCase();
  if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
    return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
  }
  return { rest: trimmed };
}

/** `off` clears the budget; anything else must be a positive integer. */
export function parseGoalBudget(raw: string): { budget?: number; error?: string } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "off") return {};
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    return { error: "Goal budget must be a positive integer or `off`." };
  }
  return { budget: parsed };
}

export function isGoalContinuationEnabled(modes: unknown): boolean {
  if (!Array.isArray(modes)) return false;
  return CONTINUATION_MODE_NAMES.some((mode) => modes.includes(mode));
}

export function toGoalStatus(state: GoalModeState | undefined): GoalStatusInfo | null {
  if (!state?.goal) return null;
  return {
    objective: state.goal.objective,
    status: state.goal.status,
    enabled: state.enabled === true,
    tokensUsed: state.goal.tokensUsed,
    ...(state.goal.tokenBudget !== undefined ? { tokenBudget: state.goal.tokenBudget } : {}),
    timeUsedSeconds: state.goal.timeUsedSeconds,
  };
}

/** Same lines the TUI prints for `/goal show`. */
export function formatGoalStatus(status: GoalStatusInfo): string {
  const used = status.tokensUsed.toLocaleString();
  const budget = status.tokenBudget !== undefined
    ? `${used} / ${status.tokenBudget.toLocaleString()} (${Math.max(0, status.tokenBudget - status.tokensUsed).toLocaleString()} left)`
    : `${used} (no budget)`;
  return [
    `Objective: ${status.objective}`,
    `Status: ${status.status}${status.enabled ? "" : " (paused)"}`,
    `Tokens: ${budget}`,
    `Time spent: ${formatDuration(status.timeUsedSeconds)}`,
  ].join("\n");
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

/**
 * Rebuild a `Goal` from a persisted `mode_change` entry. Anything missing a
 * field means the record is not usable and goal mode should not be restored.
 */
export function goalFromModeData(data: unknown): Goal | undefined {
  if (!data || typeof data !== "object") return undefined;
  const goal = (data as Record<string, unknown>).goal;
  if (!goal || typeof goal !== "object") return undefined;
  const value = goal as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.objective !== "string"
    || typeof value.status !== "string"
    || typeof value.tokensUsed !== "number"
    || typeof value.timeUsedSeconds !== "number"
    || typeof value.createdAt !== "number"
    || typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    objective: value.objective,
    status: value.status as Goal["status"],
    tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export interface GoalModeControllerOptions {
  /**
   * Runs one continuation turn. The wrapper supplies this so the turn carries
   * the same running-state bookkeeping as a browser-sent prompt.
   */
  runContinuation: (prompt: string) => Promise<void>;
  /** True while a turn (prompt, compaction, shell) is already in flight. */
  isBusy: () => boolean;
  onStatusChange?: (status: GoalStatusInfo | null) => void;
  /** Overridable so tests do not have to wait out the operator's grace period. */
  continuationDelayMs?: number;
}

/**
 * The half of omp's goal mode that does not belong to the TUI: entering and
 * leaving the mode, the goal tool, and the continuation loop that keeps the
 * agent working towards the objective between turns.
 *
 * omp ships goal mode as `InteractiveMode` methods driven by `handleTui`, so
 * `/goal` never reached ACP/text hosts like this one — the browser forwarded
 * it to the model as an ordinary prompt. This drives the same `GoalRuntime`
 * the TUI does, so a goal survives moving between the two.
 */
export class GoalModeController {
  #session: GoalModeSession;
  #options: GoalModeControllerOptions;
  /** Tool set to restore on exit; also marks "we entered the mode". */
  #previousTools: string[] | undefined;
  #continuationTimer: ReturnType<typeof setTimeout> | undefined;
  #continuationInFlight = false;
  #turnHadToolCalls = false;
  #suppressNextContinuation = false;
  #disposed = false;
  #restorePromise: Promise<void> | undefined;

  constructor(session: GoalModeSession, options: GoalModeControllerOptions) {
    this.#session = session;
    this.#options = options;
  }

  getStatus(): GoalStatusInfo | null {
    return toGoalStatus(this.#session.getGoalModeState?.());
  }

  get enabled(): boolean {
    return this.#session.getGoalModeState?.()?.enabled === true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelContinuation();
  }

  /**
   * Re-attach to a goal persisted by an earlier run of this session — the TUI
   * or a previous browser session. `onThreadResumed` pauses a goal that was
   * active when its process went away, so nothing auto-continues until the
   * operator asks for it.
   */
  restore(): Promise<void> {
    this.#restorePromise ??= this.#restore();
    return this.#restorePromise;
  }

  async #restore(): Promise<void> {
    if (this.#session.getGoalModeState?.()) return;
    const mode = this.#latestModeChange();
    if (mode?.mode !== "goal" && mode?.mode !== "goal_paused") return;

    if (!this.#goalSettingEnabled()) {
      this.#session.goalRuntime.clearAccounting();
      this.#session.sessionManager.appendModeChange("none");
      return;
    }
    const goal = goalFromModeData(mode.data);
    if (!goal) {
      this.#session.sessionManager.appendModeChange("none");
      return;
    }
    this.#session.setGoalModeState?.({ enabled: mode.mode === "goal", mode: "active", goal });
    const restored = await this.#session.goalRuntime.onThreadResumed();
    if (!restored?.goal) return;
    // The SDK builds the initial tool set without `goal`, so re-add it or the
    // agent cannot resume, complete, or drop the goal it just inherited.
    await this.#addGoalTool();
    this.#notifyStatus();
  }

  /** Dispatch `/goal [subcommand] [args]`. */
  async handleCommand(args: string): Promise<GoalCommandResult> {
    // A goal persisted by an earlier run is restored in the background at
    // attach; act on the settled state, not a half-restored one.
    await this.restore().catch(() => {});
    if (!this.#goalSettingEnabled()) {
      return this.#fail("Goal mode is disabled. Enable it in settings (goal.enabled).");
    }
    if (this.#session.getPlanModeState?.()?.enabled) {
      return this.#fail("Exit plan mode first.");
    }

    const { sub, rest } = parseGoalCommand(args);
    switch (sub) {
      case "show": return this.#show();
      case "pause": return await this.#pause();
      case "resume": return await this.#resume();
      case "drop": return await this.#drop();
      case "budget": return await this.#budget(rest);
      case "set": return await this.#set(rest);
      default: break;
    }

    const state = this.#session.getGoalModeState?.();
    // A bare `/goal` with a goal already recorded reports it: the TUI opens a
    // menu here, and this host has no menu to open.
    if (!rest) return state ? this.#show() : this.#fail("Usage: /goal <objective>, or /goal set <objective>.");
    if (state?.enabled) {
      return this.#fail("Goal mode is already active. Use /goal set to replace it, or /goal drop to start over.");
    }
    if (this.#pausedGoal()) {
      return this.#fail("Resume the current goal first, or drop it before setting a new objective.");
    }
    return await this.#start(rest);
  }

  /**
   * Reconcile with a tool-set change made elsewhere (the browser's tool preset
   * picker). While a goal is live the goal tool has to survive it, or the
   * agent loses the ability to complete or drop the goal it is working on.
   */
  reconcileToolNames(toolNames: string[]): string[] {
    if (!this.enabled && !this.#pausedGoal()) return toolNames;
    this.#previousTools = toolNames.filter((name) => name !== "goal");
    return [...new Set([...toolNames, "goal"])];
  }

  /** A real prompt from the operator means the next continuation is wanted. */
  onUserPrompt(): void {
    this.#suppressNextContinuation = false;
    this.#cancelContinuation();
  }

  onAbort(): void {
    this.#cancelContinuation();
  }

  async handleSessionEvent(event: { type: string; [key: string]: unknown }): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.#turnHadToolCalls = false;
        this.#cancelContinuation();
        return;
      case "tool_execution_start":
        this.#turnHadToolCalls = true;
        if (!this.#continuationInFlight) this.#suppressNextContinuation = false;
        return;
      case "goal_updated": {
        const state = event.state as GoalModeState | undefined;
        if (state?.goal?.status === "dropped") {
          await this.#exit({ reason: "dropped" });
          return;
        }
        // The goal tool can enable the mode without going through a command
        // (the agent calling `goal create`). Record the tool set to restore so
        // exiting does not leave the goal tool behind.
        if (state?.enabled && !this.#previousTools) {
          this.#previousTools = this.#session.getEnabledToolNames().filter((name) => name !== "goal");
        }
        // An interrupted turn pauses the goal inside the SDK, which is what
        // stops the loop after the operator aborts.
        if (!state?.enabled) this.#cancelContinuation();
        this.#notifyStatus();
        return;
      }
      case "agent_end": {
        if (this.#continuationInFlight) {
          // A continuation that produced no tool calls is the agent saying it
          // has nothing left to do; another identical nudge would just loop.
          this.#suppressNextContinuation = !this.#turnHadToolCalls;
          this.#continuationInFlight = false;
        }
        if (this.#session.getGoalModeState?.()?.mode === "exiting") {
          await this.#exit({ reason: "completed" });
          return;
        }
        this.#scheduleContinuation();
        return;
      }
      default:
        return;
    }
  }

  // --------------------------------------------------------------------------
  // Subcommands
  // --------------------------------------------------------------------------

  #show(): GoalCommandResult {
    const status = this.getStatus();
    if (!status) return this.#fail("No goal set.");
    return { message: formatGoalStatus(status), status };
  }

  async #set(rest: string): Promise<GoalCommandResult> {
    if (!rest) return this.#fail("Usage: /goal set <objective>");
    if (!this.enabled && this.#pausedGoal()) {
      return this.#fail("Resume the current goal first, or drop it before setting a new objective.");
    }
    if (!this.enabled) return await this.#start(rest);

    const state = await this.#session.goalRuntime.replaceGoal({ objective: rest });
    this.#session.setGoalModeState?.(state);
    this.#suppressNextContinuation = false;
    if (this.#session.isStreaming) {
      await this.#session.sendGoalModeContext({ deliverAs: "steer" });
    }
    return { message: "Goal replaced.", prompt: rest, status: this.getStatus() };
  }

  async #start(objective: string): Promise<GoalCommandResult> {
    const previousTools = this.#session.getEnabledToolNames().filter((name) => name !== "goal");
    const state = await this.#session.goalRuntime.createGoal({ objective });
    this.#previousTools = previousTools;
    await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
    this.#session.setGoalModeState?.(state);
    this.#suppressNextContinuation = false;
    if (this.#session.isStreaming) {
      await this.#session.sendGoalModeContext({ deliverAs: "steer" });
    }
    this.#notifyStatus();
    return { message: "Goal mode enabled.", prompt: objective, status: this.getStatus() };
  }

  async #pause(): Promise<GoalCommandResult> {
    if (!this.enabled) return this.#fail("No active goal to pause.");
    await this.#session.goalRuntime.pauseGoal();
    await this.#exit({ reason: "paused" });
    return { message: "Goal mode paused.", status: this.getStatus() };
  }

  async #resume(): Promise<GoalCommandResult> {
    if (!this.#pausedGoal()) return this.#fail("No paused goal to resume.");
    const previousTools = this.#session.getEnabledToolNames().filter((name) => name !== "goal");
    const state = await this.#session.goalRuntime.resumeGoal();
    this.#previousTools = previousTools;
    await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
    this.#session.setGoalModeState?.(state);
    this.#suppressNextContinuation = false;
    this.#notifyStatus();
    this.#scheduleContinuation();
    return { message: "Goal mode resumed.", status: this.getStatus() };
  }

  async #drop(): Promise<GoalCommandResult> {
    if (!this.enabled && !this.#pausedGoal()) return this.#fail("No goal to drop.");
    await this.#session.goalRuntime.dropGoal();
    await this.#exit({ reason: "dropped" });
    return { message: "Goal dropped.", status: this.getStatus() };
  }

  async #budget(rest: string): Promise<GoalCommandResult> {
    const state = this.#session.getGoalModeState?.();
    if (!this.enabled || !state?.enabled) {
      return this.#fail(this.#pausedGoal() ? "Resume the goal before adjusting the budget." : "No active goal.");
    }
    if (state.goal.status === "complete") return this.#fail("Goal is already complete.");
    if (!rest) return this.#fail("Usage: /goal budget <N|off>");

    const { budget, error } = parseGoalBudget(rest);
    if (error) return this.#fail(error);
    await this.#session.goalRuntime.onBudgetMutated(budget);
    this.#suppressNextContinuation = false;
    this.#notifyStatus();
    this.#scheduleContinuation();
    return {
      message: budget === undefined ? "Goal budget cleared." : `Goal budget set to ${budget.toLocaleString()}.`,
      status: this.getStatus(),
    };
  }

  // --------------------------------------------------------------------------
  // Mode transitions
  // --------------------------------------------------------------------------

  async #exit(options: { reason: "completed" | "paused" | "dropped" }): Promise<void> {
    const previousTools = this.#previousTools;
    if (previousTools) await this.#session.setActiveToolsByName(previousTools);
    if (options.reason === "completed") {
      const goal = this.#session.getGoalModeState?.()?.goal;
      this.#session.setGoalModeState?.(undefined);
      this.#session.sessionManager.appendModeChange("none");
      this.#session.sessionManager.appendCustomEntry("goal-completed", {
        objective: goal?.objective,
        tokensUsed: goal?.tokensUsed,
        tokenBudget: goal?.tokenBudget,
        timeUsedSeconds: goal?.timeUsedSeconds,
      });
    }
    this.#previousTools = undefined;
    this.#continuationInFlight = false;
    this.#cancelContinuation();
    this.#notifyStatus();
  }

  async #addGoalTool(): Promise<void> {
    const previousTools = this.#session.getEnabledToolNames().filter((name) => name !== "goal");
    this.#previousTools = previousTools;
    await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
  }

  // --------------------------------------------------------------------------
  // Continuation loop
  // --------------------------------------------------------------------------

  #scheduleContinuation(): void {
    this.#cancelContinuation();
    if (this.#disposed) return;
    if (!isGoalContinuationEnabled(getSetting(this.#session.settings, "goal.continuationModes"))) return;
    if (this.#session.getPlanModeState?.()?.enabled) return;
    if (this.#suppressNextContinuation) return;
    const state = this.#session.getGoalModeState?.();
    if (!state?.enabled || state.goal.status !== "active") return;
    if (!this.#session.goalRuntime.buildContinuationPrompt()) return;

    this.#continuationTimer = setTimeout(() => {
      this.#continuationTimer = undefined;
      void this.#runContinuation();
    }, this.#options.continuationDelayMs ?? GOAL_CONTINUATION_DELAY_MS);
  }

  async #runContinuation(): Promise<void> {
    if (this.#disposed || this.#suppressNextContinuation) return;
    // The timer can outlive the idle window that scheduled it: an operator
    // prompt (or an extension) may have started a turn while it waited.
    if (this.#options.isBusy()) return;
    const state = this.#session.getGoalModeState?.();
    if (!state?.enabled || state.goal.status !== "active") return;
    const prompt = this.#session.goalRuntime.buildContinuationPrompt();
    if (!prompt) return;

    this.#continuationInFlight = true;
    try {
      await this.#options.runContinuation(prompt);
    } catch {
      // A failed continuation must not wedge the loop: agent_end still fires
      // for the operator's next turn, which reschedules from a clean state.
      this.#continuationInFlight = false;
    }
  }

  #cancelContinuation(): void {
    if (!this.#continuationTimer) return;
    clearTimeout(this.#continuationTimer);
    this.#continuationTimer = undefined;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  #fail(error: string): GoalCommandResult {
    return { error, status: this.getStatus() };
  }

  #goalSettingEnabled(): boolean {
    return getSetting(this.#session.settings, "goal.enabled") !== false;
  }

  #pausedGoal(): GoalModeState | undefined {
    const state = this.#session.getGoalModeState?.();
    if (!state?.goal || state.enabled || state.goal.status !== "paused") return undefined;
    return state;
  }

  #latestModeChange(): { mode?: string; data?: Record<string, unknown> } | undefined {
    const entries = this.#session.sessionManager.getEntries() as Array<{
      type?: string;
      mode?: string;
      data?: Record<string, unknown>;
    }>;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.type === "mode_change") return entries[index];
    }
    return undefined;
  }

  #notifyStatus(): void {
    this.#options.onStatusChange?.(this.getStatus());
  }
}
