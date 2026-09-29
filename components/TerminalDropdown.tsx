"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalSummary {
  id: string;
  cwd: string;
  pid: number;
  status: "running" | "exited";
  shell: string;
  createdAt: number;
}

interface Props {
  cwd?: string | null;
  onOpenTerminal: (terminalId: string) => void;
  disabled?: boolean;
}

export function TerminalDropdown({ cwd, onOpenTerminal, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal");
      if (!res.ok) return;
      const data = await res.json() as { terminals: TerminalSummary[] };
      setTerminals(data.terminals);
    } catch {
      // Network blip; keep the cached list rather than showing an error.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleNew = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwd ?? undefined, cols: 100, rows: 30 }),
      });
      const data = await res.json().catch(() => ({})) as { terminal?: TerminalSummary; error?: string };
      if (!res.ok || !data.terminal) {
        setError(data.error ?? `Failed to spawn (${res.status})`);
        return;
      }
      onOpenTerminal(data.terminal.id);
      setOpen(false);
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [cwd, onOpenTerminal, refresh]);

  const handleKill = useCallback(async (id: string) => {
    await fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    void refresh();
  }, [refresh]);

  const runningCount = terminals.filter((t) => t.status === "running").length;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", height: "100%" }}>
      <button
        type="button"
        className="omp-press-tint"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={disabled ? "Select a project to open a terminal" : "Terminal"}
        aria-label="Terminal"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 12px",
          background: open ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
          borderRight: "1px solid var(--border)",
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          fontSize: 11,
          whiteSpace: "nowrap",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span>Terminal</span>
        {runningCount > 0 && (
          <span
            aria-label={`${runningCount} running`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--accent-fg, #fff)",
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            {runningCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="omp-slide-in-down"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            minWidth: 280,
            maxWidth: 420,
            marginTop: 2,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            zIndex: 250,
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="omp-press"
            onClick={() => void handleNew()}
            disabled={busy || disabled}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 12px",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid var(--border)",
              color: busy ? "var(--text-dim)" : "var(--text)",
              cursor: busy || disabled ? "not-allowed" : "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
            <span style={{ flex: 1 }}>New terminal</span>
            {cwd && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {cwd}
              </span>
            )}
          </button>
          {error && (
            <div style={{ padding: "8px 12px", color: "#f87171", fontSize: 11, background: "rgba(239,68,68,0.08)" }}>
              {error}
            </div>
          )}
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            {terminals.length === 0 && (
              <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>
                No terminals yet
              </div>
            )}
            {terminals.map((t) => (
              <div
                key={t.id}
                role="menuitem"
                className="omp-press-tint"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  cursor: t.status === "running" ? "pointer" : "default",
                  opacity: t.status === "running" ? 1 : 0.55,
                  borderBottom: "1px solid var(--border)",
                }}
                onClick={() => {
                  if (t.status !== "running") return;
                  onOpenTerminal(t.id);
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  if (t.status === "running") e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span
                  aria-label={t.status}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: t.status === "running" ? "#4ade80" : "var(--text-dim)",
                    boxShadow: t.status === "running" ? "0 0 4px #4ade80" : "none",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.cwd}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {t.shell} · pid {t.pid}
                  </div>
                </div>
                <button
                  type="button"
                  className="omp-press"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleKill(t.id);
                  }}
                  title="Kill terminal"
                  aria-label={`Kill terminal in ${t.cwd}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    padding: 0,
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
