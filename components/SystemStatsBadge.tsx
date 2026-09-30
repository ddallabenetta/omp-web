"use client";

import { useEffect, useRef, useState } from "react";

interface Stats {
  cpuPercent: number | null;
  cpuCores: number;
  cpuCoresSource?: string;
  loadAvg: { "1m": number; "5m": number; "15m": number };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number; totalSource?: string };
  // Present on every response. The fields are null on a machine with no GPU, or
  // with a GPU whose driver exposes no utilisation figure (Intel), which is
  // why `present` is separate from the numbers.
  gpu: {
    present: boolean;
    vendor: string | null;
    utilizationPercent: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    source: string | null;
  };
  process: { pid: number; rssBytes: number; heapBytes: number; uptimeSec: number };
  sampledAt: number;
}

const MAX_HISTORY_SECONDS = 10;
const POLL_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS_LIVE = 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function colorFor(percent: number | null): string {
  if (percent === null) return "var(--text-dim)";
  if (percent >= 90) return "#ef4444";
  if (percent >= 70) return "#d6a84b";
  return "#4ade80";
}

interface Sample {
  ts: number;
  cpu: number | null;
  mem: number;
  gpu: number | null;
}

function Sparkline({
  samples,
  accessor,
  color,
}: {
  samples: Sample[];
  accessor: (s: Sample) => number | null;
  color: string;
}) {
  const width = 220;
  const height = 44;
  const padX = 4;
  const padY = 6;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const values = samples.map(accessor);
  // Skip nulls for the y-range calc but keep them as gaps in the line.
  const defined = values.filter((v): v is number => v !== null);
  const maxV = Math.max(100, ...defined);
  const minV = Math.min(0, ...defined);
  const range = Math.max(1, maxV - minV);

  const points: string[] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const x = samples.length <= 1 ? padX : padX + (i / (samples.length - 1)) * plotW;
    const y = padY + plotH - ((v - minV) / range) * plotH;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  const polyline = points.length >= 2 ? points.join(" ") : "";
  const lastPoint = points.length > 0 ? points[points.length - 1].split(",") : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="last 10 seconds"
      style={{ display: "block" }}
    >
      {/* horizontal 50% guide */}
      <line
        x1={padX}
        x2={width - padX}
        y1={padY + plotH / 2}
        y2={padY + plotH / 2}
        stroke="var(--border)"
        strokeDasharray="2 4"
        strokeWidth={1}
      />
      {polyline && (
        <polyline
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polyline}
        />
      )}
      {lastPoint && (
        <circle cx={Number(lastPoint[0])} cy={Number(lastPoint[1])} r={2.5} fill={color} />
      )}
      {samples.length === 0 && (
        <text
          x={width / 2}
          y={height / 2 + 4}
          textAnchor="middle"
          fill="var(--text-dim)"
          fontSize={11}
          fontFamily="var(--font-mono)"
        >
          collecting…
        </text>
      )}
    </svg>
  );
}

export function SystemStatsBadge() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/system-stats");
        if (!res.ok) return;
        const data = await res.json() as Stats;
        if (cancelled) return;
        setStats(data);
        const cpuPct = data.cpuPercent ?? null;
        const memPct = data.memory.usedPercent;
        const gpuPct = data.gpu?.utilizationPercent ?? null;
        setHistory((prev) => {
          const cutoff = Date.now() - MAX_HISTORY_SECONDS * 1000;
          const next: Sample[] = [...prev, { ts: data.sampledAt, cpu: cpuPct, mem: memPct, gpu: gpuPct }];
          return next.filter((s) => s.ts >= cutoff);
        });
      } catch {
        // Network blip; keep the last known sample.
      }
    };
    void tick();
    const interval = setInterval(tick, open ? POLL_INTERVAL_MS_LIVE : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cpuPct: number | null = stats ? (stats.cpuPercent ?? null) : null;
  const memPct: number | null = stats ? stats.memory.usedPercent : null;
  const gpuPct: number | null = stats?.gpu?.utilizationPercent ?? null;
  // Distinguishes "this machine has no GPU" from "the GPU is busy but idle",
  // which are otherwise the same em dash. An Intel iGPU is the third case:
  // a device is there, the driver just exposes no percentage.
  const gpuLabel = !stats?.gpu?.present
    ? "no GPU detected"
    : stats.gpu.vendor === "intel"
      ? `${stats.gpu.vendor} gpu, driver exposes no load counter`
      : `GPU: ${gpuPct === null ? "—" : gpuPct.toFixed(1)}%` +
        (stats.gpu.memoryTotalBytes ? ` · ${formatBytes(stats.gpu.memoryUsedBytes ?? 0)} of ${formatBytes(stats.gpu.memoryTotalBytes)}` : "");

  const last = history.length > 0 ? history[history.length - 1] : null;
  const tooltip = stats
    ? `CPU: ${cpuPct === null ? "—" : cpuPct.toFixed(1)}% across ${stats.cpuCores} cores · ` +
      `loadavg ${stats.loadAvg["1m"].toFixed(2)} / ${stats.loadAvg["5m"].toFixed(2)} / ${stats.loadAvg["15m"].toFixed(2)} · ` +
      `memory ${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)} · ` +
      `${gpuLabel} · ` +
      `process pid ${stats.process.pid} rss ${formatBytes(stats.process.rssBytes)}`
    : "Loading…";

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", height: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="System resource usage, click for history"
        title={tooltip}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 12px",
          height: "100%",
          background: open ? "var(--bg-selected)" : "none",
          border: "none",
          borderRight: "1px solid var(--border)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={stats ? `CPU across ${stats.cpuCores} cores` : undefined}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: colorFor(cpuPct), flexShrink: 0 }} />
          <span style={{ color: "var(--text-dim)" }}>CPU</span>
          <span style={{ color: "var(--text)", fontWeight: 500 }}>
            {cpuPct === null ? "—" : `${cpuPct.toFixed(0)}%`}
          </span>
          {/* The absolute figure is the one people check against `nproc`, so it
              belongs next to the percentage rather than only in the popover. */}
          <span style={{ color: "var(--text-dim)" }}>
            {stats ? `${stats.cpuCores}c` : ""}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={stats ? `Memory: ${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}` : undefined}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: colorFor(memPct), flexShrink: 0 }} />
          <span style={{ color: "var(--text-dim)" }}>RAM</span>
          <span style={{ color: "var(--text)", fontWeight: 500 }}>
            {memPct === null ? "—" : `${memPct.toFixed(0)}%`}
          </span>
          <span style={{ color: "var(--text-dim)" }}>
            {stats ? formatBytes(stats.memory.totalBytes) : ""}
          </span>
        </span>
        {/* Always rendered, so an em dash reads as "not measurable here" rather
            than "there is no GPU at all" — otherwise the entry silently
            disappears on exactly the machines a person is wondering about. */}
        <span style={{ display: "flex", alignItems: "center", gap: 4 }} title={stats ? gpuLabel : undefined}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: colorFor(gpuPct), flexShrink: 0 }} />
          <span style={{ color: "var(--text-dim)" }}>GPU</span>
          <span style={{ color: "var(--text)", fontWeight: 500 }}>
            {gpuPct === null ? "—" : `${gpuPct.toFixed(0)}%`}
          </span>
          <span style={{ color: "var(--text-dim)" }}>
            {stats?.gpu?.present ? (stats.gpu.vendor ?? "") : ""}
          </span>
        </span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="System resource history"
          className="omp-pop-in"
          style={{
            position: "absolute",
            top: "calc(100% - 1px)",
            right: 0,
            marginTop: 2,
            minWidth: 280,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
            zIndex: 220,
            padding: "10px 12px 12px",
            transformOrigin: "top right",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flex: 1 }}>
              last {MAX_HISTORY_SECONDS}s · {history.length} samples
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                padding: 0,
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", alignItems: "center", columnGap: 8, rowGap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>CPU</span>
            <Sparkline samples={history} accessor={(s) => s.cpu} color={colorFor(cpuPct)} />
            <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "right" }}>
              {last?.cpu === null || last?.cpu === undefined ? "—" : `${last.cpu.toFixed(0)}%`}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>RAM</span>
            <Sparkline samples={history} accessor={(s) => s.mem} color={colorFor(memPct)} />
            <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "right" }}>
              {last ? `${last.mem.toFixed(0)}%` : "—"}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>GPU</span>
            <Sparkline samples={history} accessor={(s) => s.gpu} color={colorFor(gpuPct)} />
            <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "right" }}>
              {last?.gpu === null || last?.gpu === undefined ? "—" : `${last.gpu.toFixed(0)}%`}
            </span>
          </div>
          {stats && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
              <div>cores: {stats.cpuCores} · loadavg {stats.loadAvg["1m"].toFixed(2)} / {stats.loadAvg["5m"].toFixed(2)} / {stats.loadAvg["15m"].toFixed(2)}</div>
              <div>mem: {formatBytes(stats.memory.usedBytes)} / {formatBytes(stats.memory.totalBytes)}</div>
              <div>
                gpu: {stats.gpu.present
                  ? stats.gpu.utilizationPercent === null
                    ? `${stats.gpu.vendor ?? "unknown"}, no load counter exposed`
                    : `${stats.gpu.utilizationPercent.toFixed(0)}%` +
                      (stats.gpu.memoryTotalBytes
                        ? ` · ${formatBytes(stats.gpu.memoryUsedBytes ?? 0)} / ${formatBytes(stats.gpu.memoryTotalBytes)} vram`
                        : "")
                  : "none detected"}
              </div>
              <div>pid: {stats.process.pid} · rss: {formatBytes(stats.process.rssBytes)}</div>
              {/* Where the two totals came from. In a container or a cgroup-capped
                  service these differ from the host's `free -h`, and naming the
                  source is the difference between "the badge is wrong" and
                  "the badge is describing this process's share". */}
              {(stats.memory.totalSource || stats.cpuCoresSource) && (
                <div style={{ marginTop: 4, opacity: 0.75 }}>
                  total ram: {stats.memory.totalSource ?? "unknown"}
                  <br />
                  core count: {stats.cpuCoresSource ?? "unknown"}
                </div>
              )}
              {/* The GPU source joins the other two because an em dash there is
                  ambiguous on its own: a machine with no GPU, and a machine
                  whose driver publishes no counter, look identical otherwise. */}
              {stats.gpu.source !== null && (
                <div style={{ marginTop: 4, opacity: 0.75 }}>gpu source: {stats.gpu.source}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
