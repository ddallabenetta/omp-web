"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { stripAnsi } from "@/lib/ansi";
import { canApplySessionIdentity, isPromptRejectedError, sendAgentCommand, type RuntimeSessionBinding } from "@/lib/agent-client";
import { rememberSessionContinuation, clearSessionContinuation } from "@/lib/workspace-memory";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { ContextUsage, GoalStatusInfo, SessionStatsInfo, SlashCommandInfo } from "@/lib/omp-types";
import type { ModelRoleAssignment } from "@/lib/api-types";

export interface SessionData {
  runtimeId?: string;
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  contextUsage?: ContextUsage;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    configuredThinkingLevel?: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  runtimeId?: string;
  sessionId?: string;
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  configuredThinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  isHandoffRunning?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  subagents?: SubagentSnapshot[];
  goal?: GoalStatusInfo | null;
};

interface GoalCommandResponse {
  message?: string;
  error?: string;
  prompt?: string;
  status?: GoalStatusInfo | null;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}
// State refreshes contain only live SDK entries; merge terminal frames into a bounded history.
const MAX_SUBAGENT_HISTORY = 128;

function mergeSubagentSnapshots(current: SubagentSnapshot[], incoming: SubagentSnapshot[]): SubagentSnapshot[] {
  const byId = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) byId.set(subagent.id, subagent);
  const snapshots = [...byId.values()];
  const active = snapshots
    .filter((subagent) => subagent.status === "pending" || subagent.status === "running")
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  const finished = snapshots
    .filter((subagent) => subagent.status !== "pending" && subagent.status !== "running")
    .sort((left, right) => right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id));
  return [...active, ...finished].slice(0, MAX_SUBAGENT_HISTORY);
}

type ExtensionUiDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "plan_review" }
>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}


export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; prompt?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: (sessionId?: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string, runtimeId?: string | null) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 72;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const CONTEXT_USAGE_REFRESH_MS = 1000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}


function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
  rekeyDraft?: (previousKey: string, nextKey: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  roles?: ModelRoleAssignment[];
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelRoles, setModelRoles] = useState<ModelRoleAssignment[]>([]);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [effectiveThinkingLevel, setEffectiveThinkingLevel] = useState<string | undefined>();
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const runtimeIdRef: RuntimeSessionBinding = useRef(session?.runtimeId ?? null);
  const historyRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const identityDraftKeyRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    mountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      runtimeIdRef.current = session.runtimeId ?? null;
    }
    identityDraftKeyRef.current = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined);
    return () => { mountedRef.current = false; };
  }, [session?.id, session?.runtimeId, newSessionCwd]);
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const [autoFollowPaused, setAutoFollowPaused] = useState(false);
  const [goalStatus, setGoalStatus] = useState<GoalStatusInfo | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  // Forward reference: handleSend/executeBash are declared above setAutoFollow.
  const setAutoFollowRef = useRef<(following: boolean) => void>(() => {});
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<ThinkingLevelOption | null>(null);
  const promptRunIdRef = useRef(0);
  const contextUsageRequestIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return { ...sessionStatsOverride, totalActiveMs: data?.totalActiveMs };
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, data?.totalActiveMs, session?.id, session?.name]);

  const followSessionIdentity = useCallback((nextId: string, runtimeId?: string | null) => {
    if (!mountedRef.current) return;
    const previousRuntimeId = runtimeIdRef.current;
    const handleChanged = runtimeId !== undefined && runtimeId !== previousRuntimeId;
    if (runtimeId !== undefined) runtimeIdRef.current = runtimeId;
    if (runtimeId === null && previousRuntimeId) clearSessionContinuation(undefined, previousRuntimeId);
    if (runtimeIdRef.current) rememberSessionContinuation(nextId, runtimeIdRef.current);
    if (nextId === sessionIdRef.current) {
      if (handleChanged || runtimeId === null) onSessionForked?.(nextId, runtimeId);
      return;
    }
    // Async sends awaiting the SSE handshake must use the new ID immediately;
    // React state alone leaves pending callbacks pointing at historical IDs.
    if (identityDraftKeyRef.current) {
      opts.chatInputRef?.current?.rekeyDraft?.(identityDraftKeyRef.current, nextId);
    }
    contextRequestRef.current += 1;
    identityDraftKeyRef.current = nextId;
    sessionIdRef.current = nextId;
    eventSourceSessionIdRef.current = nextId;
    onSessionForked?.(nextId, runtimeId === null ? null : runtimeIdRef.current ?? undefined);
  }, [onSessionForked, opts.chatInputRef]);

  runtimeIdRef.onIdentity = (identity, request) => {
    if (!mountedRef.current || !sessionIdRef.current) return false;
    const current = { sessionId: sessionIdRef.current, runtimeId: runtimeIdRef.current };
    if (!canApplySessionIdentity(current, identity, request)) return false;
    followSessionIdentity(identity.sessionId, identity.runtimeId);
    return true;
  };

  const followRuntimeState = useCallback((state: AgentStateResponse | undefined, requestedId: string, requestedRuntimeId: string | null) => {
    // A response from an expired handle can arrive after another request has
    // installed its replacement for the same transcript. Drop all stale state,
    // including idle flags, rather than clearing or settling that newer runtime.
    if (!mountedRef.current || sessionIdRef.current !== requestedId
      || runtimeIdRef.current !== requestedRuntimeId) return true;
    if (state?.sessionId) {
      followSessionIdentity(state.sessionId, state.runtimeId ?? null);
    }
    return false;
  }, [followSessionIdentity]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const requestId = ++historyRequestRef.current;
    const ownsHistory = () => mountedRef.current && sessionIdRef.current === sid && historyRequestRef.current === requestId;
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading && ownsHistory()) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (!ownsHistory()) return null;
      if (d.runtimeId || d.sessionId !== sid) {
        followSessionIdentity(d.sessionId, d.runtimeId);
        sid = d.sessionId;
      }
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setContextUsage(d.contextUsage ?? null);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      setThinkingLevel((d.context.configuredThinkingLevel ?? d.context.thinkingLevel ?? "off") as ThinkingLevelOption);
      setEffectiveThinkingLevel(d.context.thinkingLevel);

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const stateRes = await fetch(requestedRuntimeId
          ? `/api/agent/${encodeURIComponent(requestedRuntimeId)}`
          : `/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (!mountedRef.current || sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (followRuntimeState(liveState, sid, requestedRuntimeId)) return null;
        if (!agentState.running && liveState?.sessionId) runtimeIdRef.current = null;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) {
            setThinkingLevel((liveState.configuredThinkingLevel ?? liveState.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(liveState.thinkingLevel);
          }
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, liveState.subagents ?? []));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      if (ownsHistory()) setError(String(e));
      return null;
    } finally {
      if (ownsHistory() && (showLoading || messagesLoaded)) setLoading(false);
    }
  }, [followSessionIdentity, followRuntimeState, onSessionForked]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const requestId = ++contextRequestRef.current;
    const ownsContext = () => mountedRef.current && sessionIdRef.current === sid && contextRequestRef.current === requestId;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(runtimeIdRef.current ?? sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        sessionId?: string;
        runtimeId?: string | null;
        context: { messages: AgentMessage[]; entryIds: string[] };
        contextUsage?: ContextUsage;
      };
      if (!ownsContext()) return false;
      if (d.sessionId) followSessionIdentity(d.sessionId, d.runtimeId ?? null);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setContextUsage(d.contextUsage ?? null);
      return true;
    } catch (e) {
      if (ownsContext()) console.error("Failed to load context:", e);
      return false;
    }
  }, [followSessionIdentity]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" }, runtimeIdRef);
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!mountedRef.current || !isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      runtimeId: runtimeIdRef.current ?? undefined,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as {
        sessionId: string;
        runtimeId?: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
        configuredThinkingLevel?: ThinkingLevelOption;
      };
      if (!mountedRef.current) return null;
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      runtimeIdRef.current = result.runtimeId ?? null;
      if (result.runtimeId) rememberSessionContinuation(realId, result.runtimeId);
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.configuredThinkingLevel ?? result.thinkingLevel);
        setEffectiveThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" }, runtimeIdRef);
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventConnectionAttemptRef.current = null;
  }, []);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    if (!mountedRef.current) return Promise.reject(new Error("Session is no longer active"));
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(runtimeIdRef.current ?? sid)}/events`);
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;

    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (eventConnectionAttemptRef.current?.source === es) {
          eventConnectionAttemptRef.current.pending = false;
        }
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                mountedRef.current
                && reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
    eventConnectionAttemptRef.current = { source: es, promise, pending: true };
    return promise;
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    if (!mountedRef.current) throw new Error("Session is no longer active");
    const requestedRuntimeId = runtimeIdRef.current;
    if (requestedRuntimeId) {
      const stateRes = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId)}`);
      if (stateRes.ok) {
        const state = await stateRes.json() as { running?: boolean; state?: AgentStateResponse };
        if (!mountedRef.current || sessionIdRef.current !== sid) throw new Error("Session is no longer active");
        const stale = followRuntimeState(state.state, sid, requestedRuntimeId);
        if (!stale && !state.running) {
          if (!state.state?.sessionId) throw new Error("Runtime identity expired; reopen the intended session");
          runtimeIdRef.current = null;
        }
        sid = sessionIdRef.current ?? sid;
      }
    }
    if (!mountedRef.current) throw new Error("Session is no longer active");
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid) {
      if (current.readyState === EventSource.OPEN) return;
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        await attempt.promise;
        if (!mountedRef.current) throw new Error("Session is no longer active");
        if (eventSourceRef.current === current && current.readyState === EventSource.OPEN) return;
      }
    }

    const result = await connectEvents(sessionIdRef.current ?? sid);
    if (!mountedRef.current || eventSourceRef.current !== result.source) {
      result.source.close();
      throw new Error("Session is no longer active");
    }
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents, followRuntimeState]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);
  const appendCommandOutput = useCallback((text: string) => {
    const content = stripAnsi(text).trim();
    const message: CustomMessage = {
      role: "custom",
      customType: "command",
      content,
      display: true,
      timestamp: Date.now(),
    };
    setMessages((previous) => [...previous, message]);
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
      case "ask":
      case "plan_review":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (!mountedRef.current || notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.(sessionIdRef.current ?? undefined);
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        if (followRuntimeState(state, sid, requestedRuntimeId)) {
          if (mountedRef.current) {
            eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          }
          return;
        }
        sid = sessionIdRef.current ?? sid;
        setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
        const promptActive = Boolean(
          data.running
          && state
          && (state.isStreaming || state.isPromptRunning || state.isHandoffRunning)
        );
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }
        if (data.running && (state?.subagents?.length ?? 0) > 0) {
          eventStreamGraceTimerRef.current = setTimeout(
            () => void checkServerIdle(),
            CONTEXT_USAGE_REFRESH_MS,
          );
          return;
        }


        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, followRuntimeState]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (!mountedRef.current || promptRunIdRef.current !== runId) return;
    sid = sessionIdRef.current ?? sid;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (!mountedRef.current || promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.(sessionIdRef.current ?? undefined);
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          if (runId !== undefined && promptRunIdRef.current !== runId) return;
          const state = data.state;
          if (followRuntimeState(state, sid, requestedRuntimeId)) {
            await delay(PROMPT_SETTLE_POLL_MS);
            continue;
          }
          sid = sessionIdRef.current ?? sid;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream, followRuntimeState]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      mountedRef.current
      && bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (bashRecoveryIdRef.current !== recoveryId) return;
        if (followRuntimeState(data.state, sid, requestedRuntimeId)) continue;
        sid = sessionIdRef.current ?? sid;
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, followRuntimeState]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const requestedRuntimeId = runtimeIdRef.current;
      const res = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      if (followRuntimeState(state, sid, requestedRuntimeId)) return;
      sid = sessionIdRef.current ?? sid;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting || state.isHandoffRunning);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, followRuntimeState]);
  const refreshContextUsage = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const requestId = contextUsageRequestIdRef.current + 1;
    contextUsageRequestIdRef.current = requestId;
    try {
      const requestedRuntimeId = runtimeIdRef.current;
      const res = await fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (
        requestId !== contextUsageRequestIdRef.current
        || sessionIdRef.current !== sid
        || promptRunIdRef.current !== runId
      ) return;
      if (followRuntimeState(data.state, sid, requestedRuntimeId)) return;
      if (data.state?.model && !modelSwitchPendingRef.current) {
        setCurrentModelOverride({ provider: data.state.model.provider, modelId: data.state.model.id });
      }
      if (data.state?.contextUsage !== undefined) setContextUsage(data.state.contextUsage ?? null);
    } catch {
      // The next refresh retries; state reconciliation owns error recovery.
    }
  }, [followRuntimeState]);

  // Context usage changes after each model/tool turn, not only when the prompt
  // settles. Poll the lightweight state endpoint while the session is active
  // so the meter follows those changes even if an SSE event is missed.
  useEffect(() => {
    if (!agentRunning && !isCompacting) return;
    const refresh = () => {
      const sid = sessionIdRef.current;
      if (sid) void refreshContextUsage(sid);
    };
    refresh();
    const interval = setInterval(refresh, CONTEXT_USAGE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [agentRunning, isCompacting, refreshContextUsage]);


  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "connected":
      case "session_changed":
        if (typeof event.sessionId === "string") {
          followSessionIdentity(event.sessionId, typeof event.runtimeId === "string" ? event.runtimeId : undefined);
        }
        break;
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current;
          loadSession(sid);
          const requestedRuntimeId = runtimeIdRef.current;
          fetch(`/api/agent/${encodeURIComponent(requestedRuntimeId ?? sid)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (followRuntimeState(d.state, sid, requestedRuntimeId)) return;
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, d.state?.subagents ?? []));
              if (d.state?.goal !== undefined) setGoalStatus(d.state.goal ?? null);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "goal_status":
        setGoalStatus((event.status as GoalStatusInfo | null | undefined) ?? null);
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) onAgentEnd?.(sessionIdRef.current ?? undefined);
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        const sid = sessionIdRef.current;
        if (sid) void refreshContextUsage(sid);
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "subagent_lifecycle": {
        const payload = event.payload as {
          id?: string;
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          description?: string;
          status?: "started" | "completed" | "failed" | "aborted";
          sessionFile?: string;
          parentToolCallId?: string;
        } | undefined;
        if (!payload?.id) break;
        if (payload.status !== "started") {
          const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
            ? "failed"
            : payload.status === "aborted"
              ? "aborted"
              : "completed";
          setSubagents((current) => {
            const previous = current.find((subagent) => subagent.id === payload.id);
            const finished: SubagentSnapshot = {
              id: payload.id!,
              index: payload.index ?? previous?.index ?? 0,
              agent: payload.agent ?? previous?.agent ?? payload.id!,
              agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
              description: payload.description ?? previous?.description,
              status: terminalStatus,
              task: previous?.task,
              assignment: previous?.assignment,
              sessionFile: payload.sessionFile ?? previous?.sessionFile,
              parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
              lastUpdate: Date.now(),
              progress: previous?.progress ? { ...previous.progress, status: terminalStatus } : undefined,
            };
            return mergeSubagentSnapshots(current, [finished]);
          });
          break;
        }
        const started: SubagentSnapshot = {
          id: payload.id,
          index: payload.index ?? 0,
          agent: payload.agent ?? payload.id,
          agentSource: payload.agentSource ?? "bundled",
          description: payload.description,
          status: "running",
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [started]));
        break;
      }
      case "subagent_progress": {
        const payload = event.payload as {
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          task?: string;
          assignment?: string;
          sessionFile?: string;
          parentToolCallId?: string;
          progress?: SubagentSnapshot["progress"];
        } | undefined;
        if (!payload?.progress) break;
        const progress = payload.progress;
        const snapshot: SubagentSnapshot = {
          id: progress.id,
          index: payload.index ?? progress.index,
          agent: payload.agent ?? progress.agent,
          agentSource: payload.agentSource ?? "bundled",
          description: progress.description,
          status: progress.status,
          task: payload.task ?? progress.task,
          assignment: payload.assignment ?? progress.assignment,
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
          progress,
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [snapshot]));
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          const sid = sessionIdRef.current;
          if (sid) {
            void loadSession(sid);
            void refreshContextUsage(sid);
          }
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, followSessionIdentity, followRuntimeState, refreshContextUsage, scheduleEventStreamClose, settleUiStage]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) return;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    setAutoFollowRef.current(true);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId }, runtimeIdRef);
            }
          }
          await ensureEventsConnected(sessionIdRef.current ?? sid);
          sentSessionId = sessionIdRef.current ?? sid;
          promptRequestStarted = true;
          await sendAgentCommand(sentSessionId, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          }, runtimeIdRef);
          promoteNewSession(1, message);
        }
      } else if (session) {
        await ensureEventsConnected(sessionIdRef.current ?? session.id);
        sentSessionId = sessionIdRef.current ?? session.id;
        promptRequestStarted = true;
        await sendAgentCommand(sentSessionId, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, runtimeIdRef);
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      console.error("Failed to send message:", e);
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // The prompt never reached the agent, so restore the user's text (and
      // any attached images) into the input instead of losing it. Mirrors the
      // shell-command recovery in executeBash; restoreSubmission avoids
      // clobbering anything typed since.
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        images?.map(({ data, mimeType }) => ({ data, mimeType })),
        sessionIdRef.current ?? sentSessionId ?? session?.id ?? undefined,
      );
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, opts.chatInputRef]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setAutoFollowRef.current(true);
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      }, runtimeIdRef);
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      if (mountedRef.current) opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" }, runtimeIdRef);
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  /**
   * Fork a new session from an explicit transcript entry, or from the latest
   * persisted user entry when invoked through `/fork`.
   */
  const handleFork = useCallback(async (
    entryId?: string,
  ): Promise<{ forked: boolean; error?: string }> => {
    if (bashRunningRef.current) return { forked: false, error: "Cannot fork while a shell command is running" };
    const sid = sessionIdRef.current;
    if (!sid) return { forked: false, error: "No active session to fork" };
    setForkingEntryId(entryId ?? null);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        ...(entryId ? { entryId } : {}),
      }, runtimeIdRef);
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        if (mountedRef.current) onSessionForked?.(newSessionId);
        return { forked: true };
      }
      return { forked: false, error: "Fork was cancelled" };
    } catch (e) {
      console.error("Fork failed:", e);
      return { forked: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }, runtimeIdRef).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (!await loadContext(sid, leafId)) return;
    if (leafId && mountedRef.current && sessionIdRef.current) {
      sendAgentCommand(sessionIdRef.current, { type: "navigate_tree", targetId: leafId }, runtimeIdRef).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId }, runtimeIdRef);
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId }, runtimeIdRef);
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  /**
   * Switch the session onto the model configured for one of omp's roles.
   *
   * The role is sent along, not just the model, so the transcript records which
   * role drove the change — the same thing `/model` does in the TUI, and what
   * lets omp resolve retry fallbacks for that role later.
   */
  const handleRoleModelChange = useCallback(async (role: string) => {
    const assignment = modelRoles.find((candidate) => candidate.role === role);
    const resolved = assignment?.resolved;
    if (!resolved) return;

    if (isNew) {
      const selectedModel = { provider: resolved.provider, modelId: resolved.modelId };
      const selectedThinkingLevel = resolved.thinkingLevel as ThinkingLevelOption | undefined;
      // A role selector can pin a level (`provider/model:high`). Preserve that
      // pin for deferred creation so the initial AgentSession receives it.
      thinkingLevelOverrideRef.current = selectedThinkingLevel ?? null;
      setThinkingLevel(selectedThinkingLevel ?? "auto");
      setEffectiveThinkingLevel(undefined);
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
    }
    const sid = sessionIdRef.current ?? (isNew ? await ensuringNewSessionRef.current : null);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_role_model", role }, runtimeIdRef);
      if (!isNew) setCurrentModelOverride({ provider: resolved.provider, modelId: resolved.modelId });
    } catch (e) {
      console.error("Failed to set role model:", e);
    }
  }, [isNew, modelRoles, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" }, runtimeIdRef);
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelRoles(d.roles ?? []);
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          }, runtimeIdRef);
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" }, runtimeIdRef);
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args }, runtimeIdRef);
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" }, runtimeIdRef);
          if (stats) {
            setSessionStatsOverride(stats);
          }
          if (!mountedRef.current) return { handled: true };
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" }, runtimeIdRef);
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "fork": {
          if (!sid) return complete({ handled: true, error: "No active session to fork" });
          const result = await handleFork();
          if (!result.forked) {
            return complete({ handled: true, error: result.error ?? "Fork failed" });
          }
          return complete({ handled: true, message: "Forked a new session" });
        }

        case "goal": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<GoalCommandResponse>(sid, { type: "goal", args }, runtimeIdRef);
          setGoalStatus(result?.status ?? null);
          if (result?.error) return complete({ handled: true, error: result.error });
          // `/goal show` output belongs in the transcript, not a toast that
          // disappears before it can be read.
          if (result?.message && result.message.includes("\n")) {
            appendCommandOutput(result.message);
            if (result.prompt) return { handled: true, prompt: result.prompt };
            return { handled: true };
          }
          if (result?.prompt) {
            if (result.message) addNotice({ type: "success", message: result.message });
            return { handled: true, prompt: result.prompt };
          }
          return complete({ handled: true, message: result?.message ?? "Command completed" });
        }

        case "handoff": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot hand off while the session is busy" });
          }
          // Handoff generation is a long oneshot LLM call; keep the composer
          // busy through it with the existing agent-running state so a prompt
          // cannot race the compaction entry it commits.
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "running_command" });
          try {
            await ensureEventsConnected(sessionIdRef.current ?? sid);
            const currentSid = sessionIdRef.current ?? sid;
            const result = await sendAgentCommand<{ cancelled?: boolean }>(currentSid, {
              type: "handoff",
              ...(args ? { customInstructions: args } : {}),
            }, runtimeIdRef);
            if (!result || result.cancelled) {
              return complete({ handled: true, error: "Handoff cancelled" });
            }
            // omp 18 hands off in place, so the session keeps its id and gains
            // a handoff compaction entry: reload this transcript rather than
            // navigating to a replacement session.
            if (mountedRef.current && await loadSession(sessionIdRef.current ?? currentSid, true)) promoteNewSession();
            return complete({ handled: true, message: "Context handed off and compacted in place" });
          } finally {
            if (mountedRef.current) {
              agentRunningRef.current = false;
              setAgentRunning(false);
              setAgentPhase(null);
              const finalSid = sessionIdRef.current;
              if (finalSid) scheduleEventStreamClose(finalSid);
            }
          }
        }

        default: {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<{
            handled: boolean;
            output?: string[];
            prompt?: string;
          }>(sid, {
            type: "execute_slash_command",
            message: text,
          }, runtimeIdRef);
          if (!result?.handled) return { handled: false };
          const output = result.output?.filter((line) => line.trim()).join("\n\n") ?? "";
          if (output) appendCommandOutput(output);
          if (result.prompt) return { handled: true, prompt: result.prompt };
          if (output) return { handled: true };
          return complete({ handled: true, message: "Command completed" });
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, appendCommandOutput, ensureEventsConnected, ensureNewSession, handleFork, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, scheduleEventStreamClose]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" }, runtimeIdRef);
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (mountedRef.current && texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level;
    }
    setEffectiveThinkingLevel(undefined);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level }, runtimeIdRef);
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      addNotice({ type: "error", message: "Failed to set thinking level" });
      await loadSession(sid);
    }
  }, [isNew, loadSession, addNotice]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  // Single writer for the follow flag so the ref (read by the scroll effects)
  // and the state (read by the jump-to-bottom button) never drift apart.
  const setAutoFollow = useCallback((following: boolean) => {
    completionScrollAllowedRef.current = following;
    setAutoFollowPaused((paused) => (paused === !following ? paused : !following));
  }, []);
  setAutoFollowRef.current = setAutoFollow;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const resumeAutoFollow = useCallback(() => {
    // Clear any lingering intent window so the smooth scroll we are about to
    // start is not mistaken for the user scrolling away again.
    userScrollIntentUntilRef.current = 0;
    setAutoFollow(true);
    scrollToBottom("smooth");
  }, [scrollToBottom, setAutoFollow]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current && !bashRunningRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // The auto-follow effect refreshes the programmatic-scroll window on every
    // streaming chunk, so during a stream it is always open. Honour a scroll
    // the user actually drove (wheel/touch/pointer/keys) regardless of it,
    // otherwise following could never be paused mid-turn.
    const userDriven = Date.now() <= userScrollIntentUntilRef.current;
    if (!userDriven && Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      setAutoFollow(true);
      return;
    }
    if (userDriven) {
      setAutoFollow(false);
    }
  }, [setAutoFollow]);

  const displayedSessionIdRef = useRef(session?.id);
  useEffect(() => {
    if (session?.id && session.id !== displayedSessionIdRef.current) {
      displayedSessionIdRef.current = session.id;
      void loadSession(session.id);
    }
  }, [session?.id, loadSession]);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        const sid = sessionIdRef.current;
        if (!mountedRef.current || !sid) return;
        if (agentState?.running) {
          loadTools(sid);
          if (
            agentState.state?.isStreaming
            || agentState.state?.isPromptRunning
            || agentState.state?.isHandoffRunning
          ) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(sid);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(sid);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(sid);
          }
          if ((agentState.state?.subagents?.length ?? 0) > 0) {
            void connectEvents(sid);
          }
        }
        const state = agentState?.state;
        if (state) {
          if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
          if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
          if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
          if (state.thinkingLevel !== undefined) {
            setThinkingLevel((state.configuredThinkingLevel ?? state.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(state.thinkingLevel);
          }
          if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
          if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
          if (state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages));
          if (state.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, state.subagents ?? []));
          if (state.goal !== undefined) setGoalStatus(state.goal ?? null);
        }
      });
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("pointerdown", markUserScrollIntent);
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if ((!agentRunning && !bashRunning) || !completionScrollAllowedRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [agentRunning, bashRunning, messages.length, streamState.streamingMessage, agentPhase, pendingBash]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
      return;
    }
    if (completionScrollAllowedRef.current) {
      scrollToBottom(agentRunningRef.current || bashRunningRef.current ? "instant" : "smooth");
    }
  }, [messages.length, agentRunning, bashRunning, scrollToBottom]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, newSessionModel, toolPreset, thinkingLevel,
    effectiveThinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    autoFollowPaused, resumeAutoFollow,
    goalStatus,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
