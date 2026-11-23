import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function setup(t) {
  const inner = {
    sessionId: "extension-ui-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => "/tmp" },
    settings: Settings.isolated(),
    agent: { state: {}, abort() {} },
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
    async abort() {},
    extensionRunner: {},
  };
  const wrapper = new AgentSessionWrapper(inner, { on: () => () => {} });
  t.after(() => wrapper.destroy());
  const ui = wrapper.createExtensionUiContext();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, ui, events };
}

test("select sends option labels as strings and descriptions positionally", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Spend a saved reset?", [
    { label: "Yes", description: "Redeem now" },
    "Maybe",
    { label: "No" },
  ]);
  const request = events.at(-1);
  assert.deepEqual(request.options, ["Yes", "Maybe", "No"]);
  assert.deepEqual(request.optionDetails, [{ description: "Redeem now" }, {}, {}]);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "Yes" });
  assert.equal(await pending, "Yes");
});

test("select without descriptions omits optionDetails", (t) => {
  const { ui, events } = setup(t);
  void ui.select("Choose", ["A", { label: "B", description: "  " }]);
  const request = events.at(-1);
  assert.deepEqual(request.options, ["A", "B"]);
  assert.equal("optionDetails" in request, false);
});
