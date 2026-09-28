import { NextResponse } from "next/server";
import os from "os";
import { performance } from "perf_hooks";

export const dynamic = "force-dynamic";

interface Sample {
  // Total user+sys CPU time across all cores, in nanoseconds. Summed across
  // cores because each line in /proc/stat's `cpu` block is one core.
  cpuTotalNs: bigint;
  // process.hrtime() for elapsed wall time, nanoseconds.
  elapsedNs: bigint;
}

function readSample(): Sample {
  const cpus = os.cpus();
  let total: bigint = BigInt(0);
  for (const cpu of cpus) {
    // times are in milliseconds (number), sum across cores.
    total += BigInt(Math.round((cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq) * 1_000_000));
  }
  return { cpuTotalNs: total, elapsedNs: process.hrtime.bigint() };
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

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let cpuPercent: number | null = null;
  if (prev) {
    const cpuDelta = Number(now.cpuTotalNs - prev.cpuTotalNs);
    const elapsedDelta = Number(now.elapsedNs - prev.elapsedNs);
    if (elapsedDelta > 0 && cpuDelta > 0) {
      // cpuDelta is total CPU ns across all cores; elapsedDelta is wall ns.
      // percent = (cpuDelta / elapsedDelta) * 100, capped to [0, 100].
      cpuPercent = Math.max(0, Math.min(100, (cpuDelta / elapsedDelta) * 100));
    }
  }

  const proc = process.memoryUsage();

  const loadAvg = os.loadavg();
  const cores = os.cpus().length || 1;

  return NextResponse.json({
    cpuPercent,
    cpuCores: cores,
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
    },
    process: {
      pid: process.pid,
      rssBytes: proc.rss,
      heapBytes: proc.heapUsed,
      uptimeSec: Math.round(performance.now() / 1000),
    },
    sampledAt: Date.now(),
  });
}