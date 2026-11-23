import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AuthStorage, createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import { AgentSessionWrapper } from "./rpc-manager.ts";

const fixture = fileURLToPath(new URL("./__fixtures__/mcp-env-server.mjs", import.meta.url));

test("host-backed MCP tools execute as bash commands and remain available without bash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omp-web-mcp-"));
  const authStorage = await AuthStorage.create(":memory:");
  const manager = new MCPManager(cwd, undefined, 0);
  let session;
  let eventBus;
  let wrapper;
  try {
    const loaded = await manager.connectServers({
      fixture: { command: process.execPath, args: [fixture], timeout: 10_000 },
    }, {}, undefined, 10_000);
    assert.deepEqual([...loaded.errors], []);
    const record = manager.getTools().find((tool) => tool.name.endsWith("record"));
    assert.ok(record, "fixture tool must be discovered through the MCP host");

    ({ session, eventBus } = await createAgentSession({
      cwd,
      agentDir: cwd,
      authStorage,
      settings: Settings.isolated({ "tools.commands": true, "mcp.evalNamespaces": false }),
      sessionManager: SessionManager.inMemory(cwd),
      bindProcessState: false,
      disableExtensionDiscovery: true,
      preloadedCustomToolPaths: [],
      customCommands: [],
      skills: [],
      rules: [],
      noContextFiles: true,
      promptTemplates: [],
      slashCommands: [],
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      toolNames: ["bash"],
      mcpManager: manager,
      mcpTools: manager.getTools(),
    }));
    wrapper = new AgentSessionWrapper(session, eventBus);
    const tools = await wrapper.send({ type: "get_tools" });
    const entry = tools.find((tool) => tool.name === record.name);
    assert.equal(entry?.active, true);
    assert.equal(entry?.declarationHidden, true);

    const bash = session.getToolByName("bash");
    const result = await bash.execute("mcp-command", {
      command: `${record.name} '{"note":"host command works"}'`,
    });
    assert.match(JSON.stringify(result.content), /host command works/);

    await session.setActiveToolsByName([record.name]);
    const direct = (await wrapper.send({ type: "get_tools" })).find((tool) => tool.name === record.name);
    assert.equal(direct?.active, true);
    assert.equal(direct?.declarationHidden, undefined);
    const directResult = await session.getToolByName(record.name).execute("mcp-direct", { note: "direct tool works" });
    assert.match(JSON.stringify(directResult.content), /direct tool works/);
  } finally {
    if (wrapper) await wrapper.shutdown();
    else await session?.dispose();
    await manager.disconnectAll();
    authStorage.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
