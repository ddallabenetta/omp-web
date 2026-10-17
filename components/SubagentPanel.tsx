"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand, type RuntimeSessionBinding } from "@/lib/agent-client";
import { MessageView } from "./MessageView";

type SubagentTranscriptEntry = {
  id: string;
  message: AgentMessage;
};

type SubagentTranscriptResult = {
  fromByte: number;
  nextByte: number;
  reset: boolean;
  entries: Array<{ id?: string; type?: string; message?: AgentMessage }>;
};

function isSubagentActive(subagent: SubagentSnapshot): boolean {
  return subagent.status === "pending" || subagent.status === "running";
}

function formatSubagentDuration(durationMs = 0): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function statusColor(subagent: SubagentSnapshot): string {
  if (subagent.progress?.retryState) return "var(--warning)";
  if (isSubagentActive(subagent)) return "var(--accent)";
  if (subagent.status === "failed") return "var(--danger)";
  if (subagent.status === "aborted") return "var(--warning)";
  return "var(--success)";
}

function SubagentStatusGlyph({ subagent }: { subagent: SubagentSnapshot }) {
  const color = statusColor(subagent);
  if (isSubagentActive(subagent)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color }}>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.8" strokeDasharray="22 13">
          <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
        </circle>
      </svg>
    );
  }
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 12%, transparent)` }} />;
}

function subagentTitle(subagent: SubagentSnapshot, fallback: string): string {
  return subagent.task ?? subagent.assignment ?? subagent.description ?? fallback;
}

function subagentActivity(subagent: SubagentSnapshot, t: (key: string, params?: Record<string, string | number>) => string): string {
  const progress = subagent.progress;
  if (progress?.retryState) return t("subagents.retrying", { attempt: progress.retryState.attempt, max: progress.retryState.maxAttempts });
  if (isSubagentActive(subagent)) {
    if (progress?.currentTool) return t("subagents.usingTool", { tool: progress.currentTool });
    return progress?.lastIntent || t("subagents.running");
  }
  if (subagent.status === "failed") return t("subagents.failed");
  if (subagent.status === "aborted") return t("subagents.aborted");
  return t("subagents.finished");
}

function SubagentDetail({
  sessionId,
  runtimeId,
  onRuntimeIdentity,
  cwd,
  subagent,
  onBack,
}: {
  sessionId: string;
  runtimeId?: string;
  onRuntimeIdentity?: RuntimeSessionBinding["onIdentity"];
  cwd?: string;
  subagent: SubagentSnapshot;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const active = isSubagentActive(subagent);
  const [entries, setEntries] = useState<SubagentTranscriptEntry[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(true);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let nextByte = 0;
    setEntries([]);
    setLoadingTranscript(true);
    setTranscriptError(null);
    followTailRef.current = true;

    const loadTranscript = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const result = await sendAgentCommand<SubagentTranscriptResult>(sessionId, {
          type: "get_subagent_messages",
          subagentId: subagent.id,
          fromByte: nextByte,
        }, { current: runtimeId ?? null, onIdentity: (identity, request) => {
          if (disposed) return false;
          return onRuntimeIdentity?.(identity, request);
        } });
        if (disposed) return;
        const chunk = result.entries.flatMap((entry, index) =>
          entry.type === "message" && entry.message
            ? [{
                id: entry.id ?? `${result.fromByte}:${index}`,
                message: normalizeToolCalls(entry.message),
              }]
            : []);
        setEntries((current) => result.reset || result.fromByte === 0 ? chunk : [...current, ...chunk]);
        nextByte = result.nextByte;
        setTranscriptError(null);
      } catch (error) {
        if (!disposed) setTranscriptError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setLoadingTranscript(false);
        inFlight = false;
      }
    };

    void loadTranscript();
    const interval = active ? setInterval(() => void loadTranscript(), 1000) : undefined;
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [active, sessionId, runtimeId, onRuntimeIdentity, subagent.id]);

  useEffect(() => {
    if (!followTailRef.current) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entries.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const toolResults = useMemo(() => {
    const resultMap = new Map<string, ToolResultMessage>();
    for (const entry of entries) {
      if (entry.message.role === "toolResult") resultMap.set(entry.message.toolCallId, entry.message);
    }
    return resultMap;
  }, [entries]);

  const color = statusColor(subagent);
  const progress = subagent.progress;

  return (
    <div role="dialog" aria-label={t("subagents.details")} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "11px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <button
          type="button"
          onClick={onBack}
          title={t("subagents.back")}
          aria-label={t("subagents.back")}
          style={{ display: "grid", placeItems: "center", width: 25, height: 25, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.5 3 5.5 8l5 5" />
          </svg>
        </button>
        <span style={{ width: 8, height: 8, marginTop: 6, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 12%, transparent)`, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{subagent.id}</span>
            <span style={{ padding: "1px 5px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", fontSize: 9 }}>{subagent.agent}</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 11px", padding: "7px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color }}>{active ? t("subagents.running") : subagentActivity(subagent, t)}</span>
        <span>{formatSubagentDuration(progress?.durationMs)}</span>
        <span>{t("subagents.tools", { count: progress?.toolCount ?? 0 })}</span>
        <span>{t("subagents.tokens", { count: progress?.tokens ?? 0 })}</span>
        {progress?.resolvedModel && <span>{progress.resolvedModel}</span>}
        {progress?.currentTool && <span style={{ color: "var(--text-muted)" }}>{t("subagents.usingTool", { tool: progress.currentTool })}</span>}
      </div>

      <div
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 16px" }}
      >
        {entries.length > 0 ? entries.map((entry, index) => (
          <MessageView
            key={entry.id}
            message={entry.message}
            toolResults={toolResults}
            cwd={cwd}
            showTimestamp
            prevTimestamp={entries[index - 1]?.message.timestamp}
          />
        )) : (
          <div style={{ padding: "24px 8px", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.6, textAlign: "center" }}>
            {loadingTranscript
              ? t("subagents.loadingTranscript")
              : progress?.recentOutput?.length
                ? <pre style={{ margin: 0, textAlign: "left", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{progress.recentOutput.join("\n")}</pre>
                : t("subagents.noTranscript")}
          </div>
        )}
        {transcriptError && (
          <div role="status" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid color-mix(in srgb, var(--warning) 35%, var(--border))", borderRadius: 6, color: "var(--warning)", fontSize: 9.5, overflowWrap: "anywhere" }}>
            {t("subagents.transcriptUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}

function SubagentRow({ subagent, selected, onSelect }: { subagent: SubagentSnapshot; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const progress = subagent.progress;
  const active = isSubagentActive(subagent);
  const color = statusColor(subagent);
  const activity = subagentActivity(subagent, t);
  return (
    <button
      type="button"
      role="listitem"
      onClick={onSelect}
      title={subagentTitle(subagent, subagent.id)}
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) auto",
        columnGap: 7,
        rowGap: 2,
        alignItems: "center",
        width: "100%",
        minHeight: 47,
        padding: "6px 7px",
        border: selected ? "1px solid color-mix(in srgb, var(--accent) 38%, var(--border))" : "1px solid transparent",
        borderRadius: 7,
        background: selected ? "color-mix(in srgb, var(--accent) 7%, var(--bg-hover))" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ gridRow: "1 / span 2", display: "grid", placeItems: "center", width: 18, height: 18 }}><SubagentStatusGlyph subagent={subagent} /></span>
      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 650 }}>{subagent.id}</span>
        <span style={{ padding: "1px 4px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", fontSize: 8.5, lineHeight: 1.3 }}>{subagent.agent}</span>
      </span>
      <span style={{ color: "var(--text-dim)", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>{formatSubagentDuration(progress?.durationMs)}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: progress?.retryState ? "var(--warning)" : active ? "var(--text-muted)" : color, fontSize: 9.5 }}>{activity}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 2 7 5 3 8" /></svg>
    </button>
  );
}

export function SubagentPanel({ sessionId, runtimeId, onRuntimeIdentity, cwd, subagents }: { sessionId: string | null; runtimeId?: string; onRuntimeIdentity?: RuntimeSessionBinding["onIdentity"]; cwd?: string; subagents: SubagentSnapshot[] }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const running = subagents.filter(isSubagentActive);
  const finished = subagents.filter((subagent) => !isSubagentActive(subagent));
  const selected = selectedId ? subagents.find((subagent) => subagent.id === selectedId) ?? null : null;

  useEffect(() => {
    setSelectedId(null);
    setCollapsed(false);
  }, [sessionId]);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selected, selectedId]);

  if (!sessionId || subagents.length === 0) return null;

  return (
    <aside
      className="subagent-panel"
      aria-label={t("subagents.title")}
      style={{
        display: "flex",
        flex: "1 1 auto",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      {selected ? (
        <SubagentDetail sessionId={sessionId} runtimeId={runtimeId} onRuntimeIdentity={onRuntimeIdentity} cwd={cwd} subagent={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            aria-expanded={!collapsed}
            style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", minHeight: 42, padding: "0 11px", border: "none", borderBottom: collapsed ? "none" : "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left" }}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}><polyline points="3 2 7 5 3 8" /></svg>
            <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t("subagents.title")}</span>
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 9.5, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: running.length > 0 ? "var(--accent)" : "var(--text-dim)" }}>{t("subagents.runningCount", { count: running.length })}</span>
              <span style={{ color: "var(--text-dim)" }}>{t("subagents.finishedCount", { count: finished.length })}</span>
            </span>
          </button>

          {!collapsed && (
            <div style={{ minHeight: 0, overflowY: "auto", padding: "7px 6px 8px" }}>
              {running.length > 0 && (
                <div role="list" aria-label={t("subagents.running")}>
                  <div style={{ padding: "0 7px 4px", color: "var(--accent)", fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" }}>{t("subagents.running")}</div>
                  {running.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} selected={false} onSelect={() => setSelectedId(subagent.id)} />)}
                </div>
              )}
              {finished.length > 0 && (
                <div role="list" aria-label={t("subagents.history")} style={{ marginTop: running.length > 0 ? 8 : 0, paddingTop: running.length > 0 ? 8 : 0, borderTop: running.length > 0 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ padding: "0 7px 4px", color: "var(--text-dim)", fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" }}>{t("subagents.history")}</div>
                  {finished.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} selected={false} onSelect={() => setSelectedId(subagent.id)} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
