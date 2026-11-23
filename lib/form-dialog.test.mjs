import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formDataFromState, parseFormDialogState, prepareFormDialog } = await jiti.import("./form-dialog.ts");

const FORM = `<form>
<h3>Deploy</h3>
<img alt="logo" src="/etc/passwd.png">
<svg viewBox="0 0 10 10" aria-label="bar"><rect width="10" height="10"/></svg>
<fieldset>
  <legend>Target</legend>
  <label><input type="radio" name="env" value="staging" checked> Staging</label>
  <label><input type="radio" name="env" value="prod"> Production</label>
  <label><input type="radio" name="legacy" value="x" disabled> Legacy</label>
</fieldset>
<p>Which checks?</p>
<label><input type="checkbox" name="checks" value="lint" checked> Lint</label>
<label><input type="checkbox" name="checks" value="tests"> Tests</label>
<label>Replicas <input type="number" name="replicas" value="2"></label>
<label>Notes <textarea name="notes">draft</textarea></label>
<input type="text" placeholder="nameless">
<input type="hidden" name="source" value="smoke">
</form>`;

const empty = { choices: {}, texts: {} };

test("an untouched form submits its hidden, preselected and prefilled values", () => {
  const { form } = prepareFormDialog(FORM);
  assert.deepEqual(formDataFromState(form, empty), {
    source: "smoke",
    env: "staging",
    checks: ["lint"],
    replicas: 2,
    notes: "draft",
  });
});

test("the browser's choices replace preselections, and unchecking everything drops the field", () => {
  const { form } = prepareFormDialog(FORM);
  const data = formDataFromState(form, {
    choices: { env: { checked: [1] }, checks: { checked: [0, 1] } },
    texts: { replicas: "4" },
  });
  assert.equal(data.env, "prod");
  assert.deepEqual(data.checks, ["lint", "tests"]);
  assert.equal(data.replicas, 4);

  const cleared = formDataFromState(form, { choices: { env: { checked: [] } }, texts: {} });
  assert.equal("env" in cleared, false);
});

test("a typed Other answer replaces a radio's value and joins a checkbox group's array", () => {
  const { form } = prepareFormDialog(FORM);
  const data = formDataFromState(form, {
    choices: { env: { checked: [], other: "canary" }, checks: { checked: [1], other: "e2e" } },
    texts: {},
  });
  assert.equal(data.env, "canary");
  assert.deepEqual(data.checks, ["tests", "e2e"]);
});

test("a disabled option never submits, even when the browser reports it checked", () => {
  const { form } = prepareFormDialog(FORM);
  const data = formDataFromState(form, { choices: { legacy: { checked: [0] } }, texts: {} });
  assert.equal("legacy" in data, false);
});

test("pictures stay on the server and the browser gets numbered media blocks", () => {
  const { client, media } = prepareFormDialog(FORM);
  assert.deepEqual(media, [
    { kind: "image", src: "/etc/passwd.png" },
    { kind: "svg", markup: media[1].markup },
  ]);
  const blocks = client.sections.flatMap((section) => section.blocks);
  assert.deepEqual(blocks.filter((block) => block.kind === "media"), [
    { kind: "media", index: 0, alt: "logo" },
    { kind: "media", index: 1, alt: "bar" },
  ]);
  assert.equal(JSON.stringify(client).includes("passwd"), false);
});

test("controls without a name are not drawn, and each field carries the question it answers", () => {
  const { client } = prepareFormDialog(FORM);
  const fields = client.sections.flatMap((section) => section.blocks.flatMap((block) => (block.kind === "field" ? [block.field] : [])));
  assert.deepEqual(fields.map((field) => field.name), ["env", "legacy", "checks", "replicas", "notes"]);
  assert.equal(fields.find((field) => field.name === "checks").question, "Which checks?");
});

test("a malformed or hostile answer is rejected rather than trusted", () => {
  assert.equal(parseFormDialogState("not json"), undefined);
  assert.equal(parseFormDialogState("[]"), undefined);
  assert.equal(parseFormDialogState(JSON.stringify({ choices: { a: { checked: ["0"] } }, texts: {} })), undefined);
  assert.equal(parseFormDialogState(JSON.stringify({ choices: {}, texts: { a: 1 } })), undefined);
  assert.equal(parseFormDialogState(JSON.stringify({ choices: {}, texts: {}, timedOut: "yes" })), undefined);
});

test("field names from the model cannot reach Object.prototype through the answer", () => {
  const state = parseFormDialogState('{"choices":{},"texts":{"__proto__":"polluted","constructor":"x"}}');
  assert.deepEqual(Object.keys(state.texts), ["__proto__", "constructor"]);
  assert.equal({}.polluted, undefined);

  const { form } = prepareFormDialog('<form><input type="text" name="constructor" value="mine"></form>');
  assert.equal(formDataFromState(form, empty).constructor, "mine");
  assert.equal(formDataFromState(form, { choices: {}, texts: {} }).hasOwnProperty("constructor"), true);
});

test("a state flagged timedOut survives parsing", () => {
  assert.equal(parseFormDialogState(JSON.stringify({ choices: {}, texts: {}, timedOut: true })).timedOut, true);
});
