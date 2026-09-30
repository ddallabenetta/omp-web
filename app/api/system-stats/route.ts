import { NextResponse } from "next/server";
import os from "os";
import { performance } from "perf_hooks";
import {
  readAvailableCores,
  readGpuStats,
  readMemAvailableBytes,
  readTotalMemoryBytes,
} from "@/lib/system-resources";

export const dynamic = "force-dynamic";

interface Sample {
  // Non-idle CPU time summed across all cores, nanoseconds. Idle must be
  // tracked separately: including it makes busy/total indistinguishable and
  // pins the percentage at the cap whenever every core is mostly idle.
  busyNs: bigint;
  // process.hrtime() for elapsed wall time, nanoseconds.
  elapsedNs: bigint;
}

function readSample(): Sample {
  let busy: bigint = BigInt(0);
  for (const cpu of os.cpus()) {
    // times are in milliseconds (number). Node exposes no iowait, so busy is
    // user + nice + sys + irq across every core.
    const busyMs = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
    busy += BigInt(Math.round(busyMs * 1_000_000));
  }
  return { busyNs: busy, elapsedNs: process.hrtime.bigint() };
}

declare global {
  // Persist the previous sample across hot-reload requests so the first
  // reading after a module reload still computes a meaningful delta.
  var __ompSystemStatsPrev: Sample | undefined;
}

export async function GET() {
  const now = readSample();
  const prev = globalThis.__ompSystemStatsPrev;
  globalThis.__ompSystemStatsPrev = now;

  const { totalBytes: totalMem, source: totalMemSource } = readTotalMemoryBytes();
  const freeMem = readMemAvailableBytes(totalMem);
  const usedMem = Math.max(0, totalMem - freeMem);

  const { cores, source: coresSource } = readAvailableCores();

  let cpuPercent: number | null = null;
  if (prev) {
    const busyDelta = Number(now.busyNs - prev.busyNs);
    const elapsedDelta = Number(now.elapsedNs - prev.elapsedNs);
    // busyDelta sums busy time across every core, so it must be divided by
    // core count as well as by wall time to get per-machine utilisation.
    if (elapsedDelta > 0 && busyDelta > 0) {
      const raw = (busyDelta / elapsedDelta / cores) * 100;
      cpuPercent = Math.max(0, Math.min(100, raw));
    } else if (elapsedDelta > 0) {
      cpuPercent = 0;
    }
  }

  const proc = process.memoryUsage();
  const loadAvg = os.loadavg();

  return NextResponse.json({
    cpuPercent,
    cpuCores: cores,
    cpuCoresSource: coresSource,
    loadAvg: {
      "1m": loadAvg[0],
      "5m": loadAvg[1],
      "15m": loadAvg[2],
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
      // Which reading produced totalBytes. The popover shows it so a number
      // that disagrees with the host's `free -h` can be traced to its source
      // instead of looking like a bug.
      totalSource: totalMemSource,
    },
    // Every field is null on a machine with no usable GPU rather than the whole
    // block being omitted, so the badge can tell "no GPU here" apart from
    // "the request failed" and render an em dash instead of disappearing.
    gpu: readGpuStats(),
    process: {
      pid: process.pid,
      rssBytes: proc.rss,
      heapBytes: proc.heapUsed,
      uptimeSec: Math.round(performance.now() / 1000),
    },
    sampledAt: Date.now(),
  });
}
