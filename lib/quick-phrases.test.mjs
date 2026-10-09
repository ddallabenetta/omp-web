import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadQuickPhrases, quickPhraseCaption, saveQuickPhrases } = await jiti.import("./quick-phrases.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("an empty store yields an empty list", () => {
  assert.deepEqual(loadQuickPhrases(createStorage()), []);
});

test("roundtrips phrases through storage", () => {
  const storage = createStorage();
  const phrases = [
    { label: "Zusammenfassung", text: "Fasse den bisherigen Chat zusammen." },
    { label: "", text: "abc" },
  ];

  saveQuickPhrases(phrases, storage);
  assert.deepEqual(loadQuickPhrases(storage), phrases);
});

test("roundtrips an emptied list back to empty", () => {
  const storage = createStorage({ "omp-quick-phrases": JSON.stringify([{ label: "a", text: "b" }]) });

  saveQuickPhrases([], storage);
  assert.deepEqual(loadQuickPhrases(storage), []);
});

test("drops entries without usable text", () => {
  const storage = createStorage({
    "omp-quick-phrases": JSON.stringify([
      { label: "leer", text: "" },
      { label: "kein text" },
      { label: "falscher typ", text: 42 },
      null,
      "nur ein string",
      { label: 7, text: "label ist egal" },
    ]),
  });

  assert.deepEqual(loadQuickPhrases(storage), [{ label: "", text: "label ist egal" }]);
});

test("an invalid entry is dropped on write, not stored", () => {
  const storage = createStorage();

  const saved = saveQuickPhrases([{ label: "leer", text: "" }, { label: "gut", text: "hier" }], storage);

  assert.deepEqual(saved, [{ label: "gut", text: "hier" }]);
  assert.deepEqual(loadQuickPhrases(storage), [{ label: "gut", text: "hier" }]);
});

test("an empty list creates no button to click", () => {
  const storage = createStorage();
  saveQuickPhrases([], storage);

  // Der Composer rendert nur bei `length > 0`; eine leere Liste liefert damit
  // keinen Knopf und keinen Container.
  assert.equal(loadQuickPhrases(storage).length, 0);
});

test("unparseable content falls back to an empty list", () => {
  const storage = createStorage({ "omp-quick-phrases": "{kein json" });
  assert.deepEqual(loadQuickPhrases(storage), []);

  const notAList = createStorage({ "omp-quick-phrases": JSON.stringify({ label: "x", text: "y" }) });
  assert.deepEqual(loadQuickPhrases(notAList), []);
});

test("a storage that throws does not crash read or write", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
  };

  assert.deepEqual(loadQuickPhrases(blocked), []);
  assert.doesNotThrow(() => saveQuickPhrases([{ label: "a", text: "b" }], blocked));
});

test("a missing browser storage is treated as an empty list", () => {
  assert.deepEqual(loadQuickPhrases(null), []);
  assert.deepEqual(saveQuickPhrases([{ label: "a", text: "b" }], null), [{ label: "a", text: "b" }]);
});

test("an empty label falls back to the shortened text", () => {
  assert.equal(quickPhraseCaption({ label: "", text: "abc" }), "abc");
  assert.equal(
    quickPhraseCaption({ label: "", text: "x".repeat(80) }),
    `${"x".repeat(40)}…`,
  );
  assert.equal(quickPhraseCaption({ label: "  ", text: "abc" }), "abc");
  assert.equal(quickPhraseCaption({ label: "Label", text: "x".repeat(80) }), "Label");
});

test("a multi-line text is flattened in the caption", () => {
  assert.equal(quickPhraseCaption({ label: "", text: "Zeile eins\n  Zeile zwei" }), "Zeile eins Zeile zwei");
});