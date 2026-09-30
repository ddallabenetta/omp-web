import os from "os";
import { existsSync, readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";

/**
 * Physical memory the process is actually allowed to use, in bytes.
 *
 * `os.totalmem()` is `sysconf(_SC_PHYS_PAGES) * _SC_PAGESIZE`, which on Linux
 * reports the machine the kernel booted on. Inside an LXC container or a
 * systemd slice with a memory cap that is the *host's* RAM, not this process's
 * share of it: an 8 GB container on a 32 GB host reported 30.7 GB total, and
 * the badge showed a number the machine does not have.
 *
 * Two sources say otherwise, and they win when they are the smaller figure:
 *
 * - cgroup v2 `memory.max`, cgroup v1 `memory.limit_in_bytes`. Both are the cap
 *   the kernel enforces, and both spell "no limit" differently (`max`, or a
 *   value so large it cannot be a real limit).
 * - `MemTotal` in `/proc/meminfo`. Inside a container the kernel rewrites this
 *   to the limit as well, so it agrees with the cgroup file and covers the case
 *   where the cgroup path is not where we expected to find it.
 *
 * Taking the minimum means a mis-detected limit can never inflate the figure
 * above the host, and an unreadable one only leaves the honest `os.totalmem()`
 * in place.
 */
export function readTotalMemoryBytes(): { totalBytes: number; source: string } {
  const host = os.totalmem();

  const cgroupCandidates: Array<[string, string]> = [
    ["/sys/fs/cgroup/memory.max", "cgroup v2 memory.max"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "cgroup v1 memory.limit_in_bytes"],
  ];

  let best = host;
  let source = "os.totalmem()";

  for (const [path, label] of cgroupCandidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    // v2 spells an unlimited cgroup as the literal `max`; v1 uses a sentinel
    // that no real limit would sit at.
    if (raw === "max") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    // v1's sentinel is 9223372036854771712 on 64-bit. Anything at or above
    // 2^60 is the same "unlimited" signal expressed as a number.
    if (value >= 2 ** 60) continue;
    if (value < best) {
      best = value;
      source = label;
    }
  }

  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemTotal:\s+(\d+)\s*kB$/m.exec(meminfo);
    if (match) {
      const value = Number(match[1]) * 1024;
      if (Number.isFinite(value) && value > 0 && value < best) {
        best = value;
        source = "/proc/meminfo MemTotal";
      }
    }
  } catch {
    // Not Linux, or /proc is not mounted. The host figure stands.
  }

  return { totalBytes: best, source };
}

/**
 * Memory a new allocation could still claim, in bytes.
 *
 * MemAvailable is preferred over `os.freemem()` because freemem counts page
 * cache as used. On a container that has been up for a while, freemem reads as
 * almost nothing while the cache holds most of the memory, so "used" would sit
 * near 100% on an idle machine. MemAvailable is the kernel's own estimate of
 * what is genuinely claimable, which is the number a person comparing against
 * `free -h` is actually looking at.
 */
export function readMemAvailableBytes(totalBytes: number): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(meminfo);
    if (match) {
      const value = Number(match[1]) * 1024;
      // Clamp to the resolved total: the two come from different files, and a
      // container sitting at its cap can report slightly more available than it
      // owns, which would render as negative usage.
      if (Number.isFinite(value) && value >= 0) return Math.min(value, totalBytes);
    }
  } catch {
    // Fall through to the host-wide figure.
  }
  return Math.min(os.freemem(), totalBytes);
}

/**
 * Count the CPUs in a cpuset list such as `0-3,8,10-11`. Returns 0 for
 * anything unparseable, which the caller treats as "no opinion".
 */
export function parseCpuset(value: string): number {
  let count = 0;
  for (const part of value.split(",")) {
    const range = part.trim();
    if (range.length === 0) continue;
    const dash = range.indexOf("-");
    if (dash === -1) {
      // A bare number is a single CPU. Reject a non-numeric token so a stray
      // value cannot inflate the count.
      if (!Number.isFinite(Number(range))) return 0;
      count += 1;
    } else {
      const lo = Number(range.slice(0, dash));
      const hi = Number(range.slice(dash + 1));
      // `5-2` is malformed, not a backwards range to be reinterpreted.
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return 0;
      count += hi - lo + 1;
    }
  }
  return count;
}

/**
 * Cores this process may actually run on.
 *
 * `os.cpus().length` already reflects the container's CPU mask on Linux, so it
 * is right in practice — but it is derived from `sysconf`, and the cpuset cgroup
 * spells the same fact out explicitly. Reading it turns "the badge says 6, the
 * host has 12" into a traced decision rather than a mystery: the answer then
 * names the limit that produced it.
 *
 * This is the CPU *mask*, not a quota. A container allowed unlimited CPU on six
 * cores still reports six, which is what we want: utilisation is measured
 * against the cores that can run, not against a fraction of them.
 */
export function readAvailableCores(): { cores: number; source: string } {
  const fromOs = os.cpus().length;
  if (fromOs === 0) return { cores: 1, source: "os.cpus() (empty, assumed 1)" };

  const candidates: Array<[string, string]> = [
    ["/sys/fs/cgroup/cpuset.cpus.effective", "cpuset.cpus.effective"],
    ["/sys/fs/cgroup/cpuset/cpuset.cpus", "cpuset.cpus"],
  ];

  for (const [path, label] of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (raw.length === 0) continue;
    const count = parseCpuset(raw);
    if (count > 0) return { cores: count, source: label };
  }

  return { cores: fromOs, source: "os.cpus().length" };
}

/**
 * Read a sysfs counter that holds a bare number, e.g. "37\n".
 * Returns null for anything unparseable rather than guessing at 0.
 */
export function parseSysfsPercent(raw: string): number | null {
  const text = raw.trim();
  // Number("") is 0, so an empty file would read as "0 % busy" instead of
  // "no reading". An absent counter is not an idle GPU.
  if (text.length === 0) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

/**
 * Parse `nvidia-smi --format=csv,noheader,nounits` output:
 * `37, 812, 8159` → utilisation %, memory used, memory total (MiB).
 * Tolerates the leading spaces NVIDIA puts after each comma and a trailing
 * `[Not Supported]` cell on cards where the field is unavailable.
 */
export function parseNvidiaSmiCsv(raw: string): { utilizationPercent: number; memoryUsedBytes: number; memoryTotalBytes: number } | null {
  const line = raw.trim().split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const [util, used, total] = line.split(",").map((cell) => cell.trim());
  const utilizationPercent = Number(util);
  const usedMib = Number(used);
  const totalMib = Number(total);
  if (!Number.isFinite(utilizationPercent) || !Number.isFinite(usedMib) || !Number.isFinite(totalMib)) return null;
  return {
    utilizationPercent: Math.max(0, Math.min(100, utilizationPercent)),
    memoryUsedBytes: Math.max(0, Math.round(usedMib * 1024 * 1024)),
    memoryTotalBytes: Math.max(0, Math.round(totalMib * 1024 * 1024)),
  };
}

/**
 * Read a sysfs counter that holds a raw byte count, e.g. "8589934592\n".
 *
 * Separate from parseSysfsPercent because these files are already in bytes and
 * routinely exceed 100 — running them through a percentage parser would clamp a
 * 16 GB card to 100 and then multiply it by a mebibyte.
 */
export function parseSysfsBytes(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Which GPU vendor this machine has, decided without shelling out.
 *
 * The check is file-based on purpose. `lspci` is absent on many minimal images
 * (it is not installed on the deploy target), and shelling out to find out
 * would cost a process spawn on every request for a fact the filesystem already
 * answers.
 */
export type GpuVendor = "nvidia" | "amd" | "intel" | "none";

export function detectGpuVendor(
  exists: (path: string) => boolean,
  listDrmCards: () => string[],
): GpuVendor {
  // A discrete NVIDIA card is the most useful thing to report, and the most
  // expensive to query, so it is decided first: if one is present it outranks
  // whatever iGPU the CPU happens to also carry.
  if (exists("/dev/nvidiactl") || exists("/dev/nvidia0")) return "nvidia";
  if (exists("/dev/kfd")) return "amd";
  if (listDrmCards().length > 0) return "intel";
  return "none";
}

/**
 * DRM card directories, e.g. ["card0", "card1"].
 * Connector entries like "card0-DP-1" and the "version" file are not cards.
 */
export function listDrmCards(readDir: (path: string) => string[]): string[] {
  let entries: string[];
  try {
    entries = readDir("/sys/class/drm");
  } catch {
    return [];
  }
  return entries.filter((entry) => /^card\d+$/.test(entry));
}

/** Hard ceiling on any external command the GPU probe runs. */
const GPU_COMMAND_TIMEOUT_MS = 1500;

/**
 * Current load of the GPU, or null when this machine has none to report.
 *
 * Three sources, cheapest first, because the deploy target has no GPU at all
 * and the badge polls every few seconds:
 *
 * - AMD (amdgpu) exposes load directly in sysfs. `gpu_busy_percent` and
 *   `mem_busy_percent` are amdgpu attributes; i915 does not provide them, which
 *   is why an Intel-only machine returns null here rather than a guess.
 * - NVIDIA has no sysfs equivalent, so it is the one source that must spawn a
 *   process. It is guarded by a device-node check first, so the spawn is only
 *   ever reached on a machine that really has an NVIDIA card.
 * - Intel exposes no percentage through sysfs at all. The i915 PMU can count
 *   engine-busy time, but only as a delta between two samples, which this
 *   stateless function cannot produce honestly — reporting a cumulative counter
 *   as a percentage would be a fabricated number. So Intel reports what is
 *   true: a device is present, with no utilisation figure.
 *
 * The card index is discovered rather than assumed. It is not stable across
 * boots: the deploy target exposes its iGPU as card1 with no card0 at all.
 */
export function readGpuStats(deps: GpuProbeDeps = realGpuProbeDeps): GpuStats {
  const { exists, readDir, readFile, run } = deps;
  const vendor = detectGpuVendor(exists, () => listDrmCards(readDir));
  if (vendor === "none") return { present: false, vendor: null, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, source: null };

  if (vendor === "nvidia") {
    // Only reached when a device node exists, so the missing-binary case is the
    // exception rather than the norm. timeout is a hard wall: spawnSync kills
    // the child and returns with error ETIMEDOUT instead of hanging the route.
    const result = run("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const parsed = result.status === 0 ? parseNvidiaSmiCsv(result.stdout) : null;
    if (parsed) {
      return {
        present: true,
        vendor: "nvidia",
        utilizationPercent: parsed.utilizationPercent,
        memoryUsedBytes: parsed.memoryUsedBytes,
        memoryTotalBytes: parsed.memoryTotalBytes,
        source: "nvidia-smi",
      };
    }
    // A device node without a usable query: the card is there, the number is
    // not. Saying so beats reporting a fabricated zero.
    return { present: true, vendor: "nvidia", utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, source: null };
  }

  if (vendor === "amd") {
    for (const card of listDrmCards(readDir)) {
      const base = `/sys/class/drm/${card}/device`;
      // exists() before read(): a missing file is an ordinary outcome here, and
      // probing costs a syscall while reading throws.
      if (!exists(`${base}/gpu_busy_percent`)) continue;
      const utilizationPercent = parseSysfsPercent(readFile(`${base}/gpu_busy_percent`));
      if (utilizationPercent === null) continue;
      // mem_info_vram_* are byte counts per the amdgpu driver docs, not MiB.
      const used = exists(`${base}/mem_info_vram_used`) ? parseSysfsBytes(readFile(`${base}/mem_info_vram_used`)) : null;
      const total = exists(`${base}/mem_info_vram_total`) ? parseSysfsBytes(readFile(`${base}/mem_info_vram_total`)) : null;
      return {
        present: true,
        vendor: "amd",
        utilizationPercent,
        memoryUsedBytes: used,
        memoryTotalBytes: total,
        source: `${base}/gpu_busy_percent`,
      };
    }
  }

  return { present: true, vendor: "intel", utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, source: null };
}

/**
 * The filesystem and process boundaries of the GPU probe, injectable so the
 * whole decision tree can be exercised without the hardware it describes.
 */
export interface GpuProbeDeps {
  exists: (path: string) => boolean;
  readDir: (path: string) => string[];
  readFile: (path: string) => string;
  run: (command: string, args: string[]) => { status: number | null; stdout: string };
}

const realGpuProbeDeps: GpuProbeDeps = {
  exists: existsSync,
  readDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  run: (command, args) => {
    const result = spawnSync(command, args, {
      timeout: GPU_COMMAND_TIMEOUT_MS,
      encoding: "utf8",
      // stderr is discarded: driver chatter must never reach the server log.
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  },
};

export interface GpuStats {
  present: boolean;
  /** `null` when no GPU was found at all, so the badge can say "none" instead of naming a vendor. */
  vendor: GpuVendor | null;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  source: string | null;
}
