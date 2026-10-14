import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(new URL("./useDisplaySettings.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/display-settings/route.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");

test("serves the render-affecting settings for the requested cwd", () => {
  assert.match(routeSource, /getSettingsForCwd\(cwd\)/);
  assert.match(routeSource, /hideThinkingBlock: getSetting\(settings, "hideThinkingBlock"\) === true/);
  // Same guards as the other settings-derived endpoints.
  assert.match(routeSource, /isApiRequestAllowed\(req\)/);
  assert.match(routeSource, /isExistingFilePathAllowed\(cwd, allowedRoots\)/);
});

test("shares one store so message components do not each fetch", () => {
  assert.match(hookSource, /export function useDisplaySettings\(\): DisplaySettings \{\s*return useSyncExternalStore/);
  assert.match(hookSource, /export function useSyncedDisplaySettings\([\s\S]*?refreshDisplaySettings\(cwd\)/);
  // A slower earlier response must not overwrite a newer one.
  assert.match(hookSource, /if \(id !== requestId\) return;/);
});

test("applies the toggle to the open transcript instead of asking for a reload", () => {
  assert.match(settingsSource, /const DISPLAY_SETTING_PATHS = new Set\(\["hideThinkingBlock"\]\)/);
  assert.match(settingsSource, /DISPLAY_SETTING_PATHS\.has\(field\.path\)\) \{[\s\S]*?refreshDisplaySettings\(cwd\)/);
});
