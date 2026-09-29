import os from "os";
import { readFileSync } from "fs";

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
