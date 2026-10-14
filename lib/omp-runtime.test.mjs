import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { invalidateOmpRuntime } from "./omp-runtime.ts";

test("invalidateOmpRuntime drops the SDK's cached models.yml parse", (t) => {
  // The SDK parses models.yml into a module-level singleton. A new ModelRegistry
  // reads that cache in its constructor and then records the file's current
  // mtime as loaded, so a stale cache survives every later refresh(). Dropping
  // only omp-web's own caches leaves an edited models.yml invisible until the
  // process restarts.
  const original = ModelsConfigFile.invalidate;
  let invalidations = 0;
  ModelsConfigFile.invalidate = function invalidate(...args) {
    invalidations += 1;
    return original.apply(this, args);
  };
  t.after(() => {
    ModelsConfigFile.invalidate = original;
  });

  invalidateOmpRuntime();

  assert.equal(invalidations, 1);
});

test("models-config PUT invalidates the runtime after writing the file", async () => {
  const source = await readFile(new URL("../app/api/models-config/route.ts", import.meta.url), "utf8");
  const putSource = source.slice(source.indexOf("export async function PUT"));

  assert.match(putSource, /writeModelsConfig\(config\)/);
  assert.match(putSource, /invalidateOmpRuntime\(\)/);
  assert.ok(
    putSource.indexOf("writeModelsConfig(config)") < putSource.indexOf("invalidateOmpRuntime()"),
    "the runtime must be dropped after the write, not before",
  );
});
