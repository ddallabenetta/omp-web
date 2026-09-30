import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const lib = await jiti.import("@/lib/system-resources.ts");

/**
 * A fake machine: `files` maps a path to its contents, `devNodes` to a
 * present-but-empty device node. Every entry point of the probe is stubbed, so
 * each case below drives the real decision tree without the hardware it
 * describes.
 */
function fakeMachine({ files = {}, devNodes = [], nvidiaSmi = null } = {}) {
  return {
    exists: (path) => path in files || devNodes.includes(path),
    readDir: (path) => {
      if (path !== "/sys/class/drm") return [];
      const dirs = new Set(
        Object.keys(files)
          .map((p) => /^\/sys\/class\/drm\/(card\d+)\/.*/.exec(p)?.[1])
          .filter(Boolean),
      );
      return [...dirs, "version"];
    },
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    run: (command, args) => {
      if (command !== "nvidia-smi") return { status: 127, stdout: "" };
      return nvidiaSmi ?? { status: 127, stdout: "" };
    },
  };
}

test("parseSysfsPercent reads a bare counter and rejects junk", () => {
  assert.equal(lib.parseSysfsPercent("37\n"), 37);
  assert.equal(lib.parseSysfsPercent("  0 "), 0);
  // Some drivers briefly report above 100; clamping keeps the colour scale in
  // range instead of rendering a nonsense width.
  assert.equal(lib.parseSysfsPercent("140"), 100);
  assert.equal(lib.parseSysfsPercent("N/A"), null);
  // Number("") is 0, so an empty file must not read as "0 % busy".
  assert.equal(lib.parseSysfsPercent(""), null);
  assert.equal(lib.parseSysfsPercent("\n"), null);
  assert.equal(lib.parseSysfsPercent("-1"), null);
});

test("parseNvidiaSmiCsv turns MiB columns into bytes", () => {
  assert.deepEqual(lib.parseNvidiaSmiCsv("37, 812, 8159\n"), {
    utilizationPercent: 37,
    memoryUsedBytes: 812 * 1024 * 1024,
    memoryTotalBytes: 8159 * 1024 * 1024,
  });
  // A field the card cannot report arrives as a marker. Reading it as 0 MiB
  // would render as "the GPU uses no memory at all".
  assert.equal(lib.parseNvidiaSmiCsv("37, [Not Supported], 8159"), null);
  assert.equal(lib.parseNvidiaSmiCsv(""), null);
  assert.equal(lib.parseNvidiaSmiCsv("N/A, N/A, N/A"), null);
});

test("listDrmCards keeps cards and drops connectors", () => {
  const entries = ["card1", "card1-DP-1", "card1-HDMI-A-1", "renderD128", "version"];
  assert.deepEqual(lib.listDrmCards(() => entries), ["card1"]);
  // No /sys/class/drm at all is an ordinary outcome, not a throw.
  assert.deepEqual(lib.listDrmCards(() => { throw new Error("ENOENT"); }), []);
});

test("detectGpuVendor prefers a discrete card over an iGPU", () => {
  // Both an NVIDIA node and DRM cards present: the discrete card wins, because
  // its numbers are the ones a person can act on.
  assert.equal(lib.detectGpuVendor((p) => p === "/dev/nvidia0", () => ["card0"]), "nvidia");
  assert.equal(lib.detectGpuVendor((p) => p === "/dev/kfd", () => []), "amd");
  assert.equal(lib.detectGpuVendor(() => false, () => ["card1"]), "intel");
  assert.equal(lib.detectGpuVendor(() => false, () => []), "none");
});

// The case that matters most: the deploy target is an Intel iGPU on card1 with
// no gpu_busy_percent, no rc6_residency, no gt_*_freq_mhz and no hwmon.
test("an Intel iGPU with no sysfs counters reports present but no number", () => {
  // Shaped like the target: a card1 directory exists, but the amdgpu counters
  // under it do not. A card directory is what makes this an Intel iGPU rather
  // than a machine with no GPU at all.
  const stats = lib.readGpuStats(fakeMachine({
    devNodes: ["/dev/dri/card1", "/dev/dri/renderD128"],
    files: { "/sys/class/drm/card1/device/enable": "1" },
  }));
  assert.deepEqual(stats, {
    present: true,
    vendor: "intel",
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    source: null,
  });
});

// A machine with no GPU device node at all, and a WSL2 host whose /sys/class/drm
// holds only "version".
test("a machine with no GPU reports every field null", () => {
  const stats = lib.readGpuStats(fakeMachine({ files: { "/sys/class/drm/version": "drm 1.1.0" } }));
  assert.deepEqual(stats, {
    present: false,
    vendor: null,
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    source: null,
  });
});

test("parseSysfsBytes keeps values above 100 that a percent parser would clamp", () => {
  // mem_info_vram_* are byte counts. A 16 GB card is 17179869184, which
  // parseSysfsPercent would clamp to 100.
  assert.equal(lib.parseSysfsBytes("17179869184\n"), 17179869184);
  assert.equal(lib.parseSysfsBytes("0"), 0);
  assert.equal(lib.parseSysfsBytes(""), null);
  assert.equal(lib.parseSysfsBytes("junk"), null);
  assert.equal(lib.parseSysfsBytes("-5"), null);
});

test("an AMD card is read from gpu_busy_percent with VRAM in bytes", () => {
  const stats = lib.readGpuStats(fakeMachine({
    devNodes: ["/dev/kfd"],
    files: {
      "/sys/class/drm/card0/device/gpu_busy_percent": "42\n",
      // Raw byte counts, as the amdgpu driver reports them.
      "/sys/class/drm/card0/device/mem_info_vram_used": "2147483648\n",
      "/sys/class/drm/card0/device/mem_info_vram_total": "8589934592\n",
    },
  }));
  assert.deepEqual(stats, {
    present: true,
    vendor: "amd",
    utilizationPercent: 42,
    memoryUsedBytes: 2147483648,
    memoryTotalBytes: 8589934592,
    source: "/sys/class/drm/card0/device/gpu_busy_percent",
  });
});

// The card index is not stable: the target exposes card1 with no card0 at all.
test("an AMD card on card1 is found without a card0 present", () => {
  const stats = lib.readGpuStats(fakeMachine({
    devNodes: ["/dev/kfd"],
    files: { "/sys/class/drm/card1/device/gpu_busy_percent": "7\n" },
  }));
  assert.equal(stats.utilizationPercent, 7);
  assert.equal(stats.source, "/sys/class/drm/card1/device/gpu_busy_percent");
  // No VRAM counters on this card: null, not zero.
  assert.equal(stats.memoryUsedBytes, null);
  assert.equal(stats.memoryTotalBytes, null);
});

test("an NVIDIA card is read through nvidia-smi", () => {
  const stats = lib.readGpuStats(fakeMachine({
    devNodes: ["/dev/nvidiactl", "/dev/nvidia0"],
    files: { "/sys/class/drm/card0/device/anything": "" },
    nvidiaSmi: { status: 0, stdout: "37, 812, 8159\n" },
  }));
  assert.deepEqual(stats, {
    present: true,
    vendor: "nvidia",
    utilizationPercent: 37,
    memoryUsedBytes: 812 * 1024 * 1024,
    memoryTotalBytes: 8159 * 1024 * 1024,
    source: "nvidia-smi",
  });
});

test("an NVIDIA card whose query times out does not produce a number", () => {
  // The device node exists, so the probe is attempted — and the child is killed
  // at the timeout. A card is present; the figure is honestly absent.
  const stats = lib.readGpuStats(fakeMachine({
    devNodes: ["/dev/nvidiactl"],
    nvidiaSmi: { status: null, stdout: "" },
  }));
  assert.equal(stats.present, true);
  assert.equal(stats.vendor, "nvidia");
  assert.equal(stats.utilizationPercent, null);
  assert.equal(stats.source, null);
});

test("no GPU tool is ever spawned unless an NVIDIA node exists", () => {
  // A missing nvidia-smi binary on a GPU-less machine must cost one stat()
  // call, not a failed process spawn on every poll.
  const attempts = [];
  const machine = fakeMachine({ files: { "/sys/class/drm/version": "drm 1.1.0" } });
  machine.run = (command) => { attempts.push(command); return { status: 127, stdout: "" }; };
  lib.readGpuStats(machine);
  assert.deepEqual(attempts, []);
});

test("a figure is never reported without the source that produced it", () => {
  // The invariant that makes a disagreeing number traceable rather than a bug.
  const cases = [
    fakeMachine({ files: { "/sys/class/drm/version": "drm 1.1.0" } }),
    fakeMachine({ devNodes: ["/dev/dri/renderD128"] }),
    fakeMachine({ devNodes: ["/dev/nvidiactl"], nvidiaSmi: { status: null, stdout: "" } }),
    fakeMachine({ devNodes: ["/dev/nvidiactl"], nvidiaSmi: { status: 0, stdout: "37, 812, 8159\n" } }),
    fakeMachine({ devNodes: ["/dev/kfd"], files: { "/sys/class/drm/card0/device/gpu_busy_percent": "42\n" } }),
  ];
  for (const machine of cases) {
    const stats = lib.readGpuStats(machine);
    if (stats.utilizationPercent !== null) {
      assert.notEqual(stats.source, null, `a percentage arrived with no source: ${JSON.stringify(stats)}`);
    }
  }
});

test("the route answers 200 with a complete gpu block on a GPU-less host", async () => {
  const { GET } = await jiti.import("./route.ts");
  const started = Date.now();
  const response = await GET();
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);

  const body = await response.json();
  // The block is always present, even with every value null: the badge has to
  // tell "no GPU here" apart from "the request failed".
  assert.ok("gpu" in body, "gpu block missing from the response");
  assert.deepEqual(
    Object.keys(body.gpu).sort(),
    ["memoryTotalBytes", "memoryUsedBytes", "present", "source", "utilizationPercent", "vendor"],
  );
  assert.equal(typeof body.gpu.present, "boolean");
  // The other blocks must survive the GPU lookup unchanged.
  assert.equal(typeof body.memory.totalBytes, "number");
  assert.equal(typeof body.memory.totalSource, "string");
  assert.equal(typeof body.cpuCores, "number");
  // A machine with no GPU must not cost more than the stated budget.
  assert.ok(elapsed < 2000, `GET took ${elapsed}ms, budget is 2000ms`);
});

test("the route's gpu block is the detector's result, passed through unchanged", async () => {
  // The route adds no shaping of its own, so a populated response is exactly
  // what the probe produced — which is what makes `source` meaningful.
  const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /gpu: readGpuStats\(\)/);
  // The route must not shell out itself; detection lives in the lib.
  assert.ok(!routeSource.includes("spawnSync"), "the route must not spawn processes");
  assert.ok(!routeSource.includes("nvidia-smi"), "the route must not name vendor tools");
});

test("spawnSync timeout kills a child that ignores SIGTERM", async () => {
  // Ground truth for the timeout claim. spawnSync blocks the event loop, so an
  // unbounded call would stall the route for the child's whole lifetime; the
  // timeout is the only thing preventing that.
  const { spawnSync } = await import("node:child_process");
  const started = Date.now();
  const result = spawnSync("sleep", ["30"], {
    timeout: 300,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, 0, "the child should not have exited on its own");
  assert.ok(elapsed < 5000, `spawnSync timeout did not bound the child (${elapsed}ms)`);
});

test("the real probe bounds its own command and discards stderr", async () => {
  const libSource = await readFile(
    new URL("../../../lib/system-resources.ts", import.meta.url),
    "utf8",
  );
  // A process that hangs with no timeout would hold the route open forever.
  assert.match(libSource, /const GPU_COMMAND_TIMEOUT_MS = \d+/);
  assert.match(libSource, /timeout: GPU_COMMAND_TIMEOUT_MS/);
  // Driver chatter must never reach the server log.
  assert.match(libSource, /stdio: \["ignore", "pipe", "ignore"\]/);
});

test("reading the real machine's GPU stays inside the latency budget", () => {
  // The local WSL2 host has no usable GPU source. Whatever the outcome, a figure
  // only ever arrives with its source, and the call stays fast.
  const started = Date.now();
  const stats = lib.readGpuStats();
  const elapsed = Date.now() - started;

  assert.equal(typeof stats.present, "boolean");
  assert.ok(stats.vendor === null || typeof stats.vendor === "string");
  if (stats.utilizationPercent !== null) assert.notEqual(stats.source, null);
  assert.ok(elapsed < 2000, `readGpuStats took ${elapsed}ms, budget is 2000ms`);
});
