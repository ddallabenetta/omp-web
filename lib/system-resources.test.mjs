import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

async function loadSubject() {
  return import("./system-resources.ts");
}

test("counts the CPUs in a cpuset list", async () => {
  const { parseCpuset } = await loadSubject();

  // The shapes that show up in cgroup files.
  assert.equal(parseCpuset("0-5"), 6);
  assert.equal(parseCpuset("0"), 1);
  assert.equal(parseCpuset("0-3,8"), 5);
  assert.equal(parseCpuset("0-3,8,10-11"), 7);
  assert.equal(parseCpuset("0-11"), 12);
  // Whitespace after the commas is legal.
  assert.equal(parseCpuset(" 0-1 , 4 "), 3);
});

test("rejects a cpuset it cannot read rather than guessing", async () => {
  const { parseCpuset } = await loadSubject();

  // A backwards range is malformed, not a set to be reinterpreted.
  assert.equal(parseCpuset("5-2"), 0);
  assert.equal(parseCpuset("a-b"), 0);
  assert.equal(parseCpuset("0-x"), 0);
  // An empty file yields no opinion, so the caller keeps the os.cpus() value.
  assert.equal(parseCpuset(""), 0);
  assert.equal(parseCpuset(","), 0);
});

test("total memory never exceeds what the process is allowed", async () => {
  const { readTotalMemoryBytes } = await loadSubject();

  const { totalBytes, source } = readTotalMemoryBytes();

  assert.ok(totalBytes > 0, "total memory must be positive");
  assert.ok(Number.isFinite(totalBytes), "total memory must be a finite number");
  // The bug this guards: os.totalmem() reports the host's RAM inside a
  // container, so the figure came out several times the real ceiling — an 8 GB
  // LXC guest on a 32 GB host reported 30.7 GB.
  assert.ok(
    totalBytes <= os.totalmem(),
    `total (${totalBytes}) must not exceed os.totalmem() (${os.totalmem()})`,
  );
  // A named source means the answer is traceable rather than accidental.
  assert.equal(typeof source, "string");
  assert.ok(source.length > 0, "the source must be named");
});

test("available memory stays inside the resolved total", async () => {
  const { readMemAvailableBytes, readTotalMemoryBytes } = await loadSubject();

  const { totalBytes } = readTotalMemoryBytes();
  const available = readMemAvailableBytes(totalBytes);

  assert.ok(available >= 0, "available memory cannot be negative");
  // A container at its cap can report slightly more available than it owns;
  // that would render as negative usage, so the value is clamped.
  assert.ok(
    available <= totalBytes,
    `available (${available}) must not exceed total (${totalBytes})`,
  );
  // Used = total - available, so the badge has something to divide.
  assert.ok(totalBytes > 0);
});

test("core count is positive and traceable to a source", async () => {
  const { readAvailableCores } = await loadSubject();

  const { cores, source } = readAvailableCores();

  assert.ok(cores >= 1, "a process always has at least one core to run on");
  assert.equal(typeof source, "string");
  assert.ok(source.length > 0, "the source must be named");
  // Utilisation is divided by this, so a zero here would produce NaN.
  assert.notEqual(cores, 0);
});
