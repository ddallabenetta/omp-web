import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const { getAvailableSlashCommands, BROWSER_NATIVE_SLASH_COMMANDS } = await loadSubject();
const agentSessionSource = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

function makeSession(promptTemplates = []) {
  return {
    extensionRunner: undefined,
    customCommands: [],
    mcpPromptCommands: [],
    skills: [],
    skillsSettings: { enableSkillCommands: false },
    setSlashCommands() {},
    sessionManager: { getCwd: () => process.cwd() },
    promptTemplates,
  };
}

test("advertises browser-native fork and SDK handoff with canonical metadata", async () => {
  const commands = await getAvailableSlashCommands(makeSession());
  const byName = new Map(commands.map((command) => [command.name, command]));

  assert.equal(byName.get("fork")?.source, "builtin");
  assert.equal(byName.get("fork")?.description, "Create a new fork from a previous message");
  // omp's pane/window/tab placements open a terminal multiplexer; the browser
  // fork has nowhere to put them, so they are not advertised.
  assert.equal(byName.get("fork")?.subcommands, undefined);
  // omp 18 gave /handoff a shared SDK handler, so it reaches the palette
  // through discovery — with the registry's ACP description — rather than the
  // browser-native injection /fork still needs.
  assert.equal(byName.get("handoff")?.source, "builtin");
  assert.equal(byName.get("handoff")?.input?.hint, "[focus instructions]");
  assert.equal(new Set(byName.keys()).size, commands.length);
});

test("advertises shared SDK builtins but not TUI-only commands", async () => {
  const commands = await getAvailableSlashCommands(makeSession());
  const byName = new Map(commands.map((command) => [command.name, command]));

  // Shared text/ACP builtins come through the SDK discovery pipeline.
  assert.equal(byName.get("compact")?.source, "builtin");
  assert.equal(byName.get("compact")?.description, "Compact the conversation");

  // TUI-only commands without a shared handler are not advertised.
  assert.equal(byName.has("plan"), false);
  assert.equal(byName.has("settings"), false);
});

test("every advertised SDK builtin has an executable browser path", async () => {
  const commands = await getAvailableSlashCommands(makeSession());
  const browserNative = new Set(BROWSER_NATIVE_SLASH_COMMANDS);
  const canonicalByName = new Map(BUILTIN_SLASH_COMMANDS_INTERNAL.map((command) => [command.name, command]));

  for (const command of commands.filter((entry) => entry.source === "builtin")) {
    const canonical = canonicalByName.get(command.name);
    assert.ok(canonical, `/${command.name} must come from the canonical SDK registry`);
    assert.equal(
      Boolean(canonical.handle) || browserNative.has(command.name),
      true,
      `/${command.name} is advertised without a shared or browser-native handler`,
    );
  }

  for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL.filter((entry) => entry.handle)) {
    assert.equal(
      commands.some((entry) => entry.source === "builtin" && entry.name === command.name),
      true,
      `shared SDK command /${command.name} must remain available`,
    );
  }
});

test("every browser-native command is dispatched by the composer", async () => {
  // Advertising a name the client cannot execute sends it to the model as
  // plain text — the bug /goal had. The palette entry and the handler have to
  // be added together.
  for (const name of BROWSER_NATIVE_SLASH_COMMANDS) {
    assert.match(
      agentSessionSource,
      new RegExp(`case "${name}": \\{`),
      `/${name} is advertised but handleBuiltinSlashCommand has no case for it`,
    );
  }
});

test("advertises goal mode with its subcommands", async () => {
  const commands = await getAvailableSlashCommands(makeSession());
  const goal = commands.find((command) => command.name === "goal");

  // omp implements /goal as a TUI-only handler, so it never reaches ACP
  // discovery; omp-web drives the same GoalRuntime and advertises it here.
  assert.equal(goal?.source, "builtin");
  assert.deepEqual(
    goal?.subcommands?.map((sub) => sub.name),
    ["set", "show", "pause", "resume", "drop", "budget"],
  );
  assert.equal(goal?.input?.hint, "[objective]");
});

test("retains prompt templates alongside the SDK command registry", async () => {
  const commands = await getAvailableSlashCommands(makeSession([
    { name: "review", description: "Review the current change", source: "/tmp/review.md" },
  ]));

  assert.deepEqual(
    commands.find((command) => command.name === "review"),
    {
      name: "review",
      description: "Review the current change",
      source: "prompt",
      path: "/tmp/review.md",
    },
  );
});
