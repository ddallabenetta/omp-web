// omp 18.2 replaced the path-keyed `settings.get("a.b")` / `settings-schema`
// surface with a registry of typed `Setting` handles (`config/registry`).
// omp-web addresses settings by their dotted path — the browser sends paths,
// and the settings panel is generated from the schema — so this module is the
// single place that turns a path into a handle. Importing `all-settings`
// registers every domain, exactly as omp's own settings panel does.
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { type AnySetting, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { cfgSkills, type SkillsSettings } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AnyUiMetadata, SettingTab } from "@oh-my-pi/pi-tui/overlays/settings-defs";

export { SETTING_TABS, TAB_GROUPS, TAB_METADATA, type SettingTab } from "@oh-my-pi/pi-tui/overlays/settings-defs";

export type SettingPath = string;

// Registration happens on import; touching the ordered list keeps a bundler
// from dropping the side-effect-only import.
orderedSettings();

export function findSetting(path: SettingPath): AnySetting | undefined {
  return lookup(path);
}

function requireSetting(path: SettingPath): AnySetting {
  const setting = lookup(path);
  if (!setting) throw new Error(`Unknown setting: ${path}`);
  return setting;
}

/** Effective value (environment included), `undefined` for an unknown path. */
export function getSetting<T = unknown>(settings: Settings, path: SettingPath): T | undefined {
  return lookup(path)?.get(settings) as T | undefined;
}

/** Persists `value` to the global config layer. */
export function setSetting(settings: Settings, path: SettingPath, value: unknown): void {
  requireSetting(path).set(settings, value);
}

export function isSettingConfigured(settings: Settings, path: SettingPath): boolean {
  return lookup(path)?.isConfigured(settings) ?? false;
}

export function getSkillsSettings(settings: Settings): SkillsSettings {
  return cfgSkills.get(settings);
}

export function getDefault(path: SettingPath): unknown {
  return lookup(path)?.default;
}

export function getType(path: SettingPath): string | undefined {
  return lookup(path)?.type;
}

export function getEnumValues(path: SettingPath): readonly string[] | undefined {
  return lookup(path)?.enumValues;
}

export function getUi(path: SettingPath): AnyUiMetadata | undefined {
  return lookup(path)?.ui;
}

export function hasUi(path: SettingPath): boolean {
  return lookup(path)?.ui !== undefined;
}

export function isCredential(path: SettingPath): boolean {
  return lookup(path)?.isCredential ?? false;
}

/** Paths shown on `tab`, in omp's settings-panel order. */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
  return orderedSettings().filter((setting) => setting.ui?.tab === tab).map((setting) => setting.id);
}
