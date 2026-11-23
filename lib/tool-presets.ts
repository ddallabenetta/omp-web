export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Enabled but not declared at the top level (bash commands or eval/codemode tools). */
  declarationHidden?: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["read", "bash", "edit", "write", "grep", "glob"];

const BUILTIN_TOOL_NAMES: Record<string, true> = Object.fromEntries(
  PRESET_FULL.map((name) => [name, true]),
);

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";

  const active = activeTools
    .map((t) => t.name)
    .filter((name) => BUILTIN_TOOL_NAMES[name] === true)
    .sort()
    .join(",");
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}
