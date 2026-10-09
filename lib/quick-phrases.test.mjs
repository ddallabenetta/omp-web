import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_QUICK_PHRASES,
  clearLegacyQuickPhrases,
  normalizeQuickPhrases,
  quickPhraseCaption,
  readLegacyQuickPhrases,
  readQuickPhrasesMirror,
  writeQuickPhrasesMirror,
} = await jiti.import("./quick-phrases.ts");

/**
 * Was hier noch getestet wird, ist der Teil, der *unveraendert* blieb: die
 * Form der Phrase, die Validierung und die Beschriftung. Die Ablage selbst
 * ist ueber `lib/quick-phrases-store.test.mjs` in die Datei gewandert; die
 * Migration aus dem Browser steht hier, weil sie dieselbe Drei-Faelle-Regel
 * bewacht, die vorher der Seed im localStorage getragen hat.
 *
 * Weggefallen sind die Tests, die nur festhielten, *wo* gespeichert wurde. Ein
 * gruener Test, der `omp-quick-phrases` im localStorage behauptet, ist nach dem
 * Umbau keine Aussage mehr, sondern nur noch eine Gewohnheit — und Gewohnheiten,
 * die einen Speicherort festhalten, sind der Grund, warum ein Umbau schwerfaellt.
 */

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
    removeItem(key) {
      values.delete(key);
    },
  };
}

// --- Form und Validierung -------------------------------------------------

test("drops entries without usable text", () => {
  assert.deepEqual(
    normalizeQuickPhrases([
      { label: "leer", text: "" },
      { label: "kein text" },
      { label: "falscher typ", text: 42 },
      null,
      "nur ein string",
      { label: 7, text: "label ist egal" },
    ]),
    [{ label: "", text: "label ist egal" }],
  );
});

test("a non-list is not a list of phrases", () => {
  assert.deepEqual(normalizeQuickPhrases({ label: "x", text: "y" }), []);
  assert.deepEqual(normalizeQuickPhrases("abc"), []);
  assert.deepEqual(normalizeQuickPhrases(null), []);
});

test("an empty list creates no button to click", () => {
  // Der Composer rendert nur bei `length > 0`; eine leere Liste liefert damit
  // keinen Knopf und keinen Container.
  assert.deepEqual(normalizeQuickPhrases([]), []);
});

test("umlaute and multi-line text survive unchanged", () => {
  const phrases = [
    { label: "Grüße", text: "Zeile eins\nZeile zwei" },
    { label: "", text: "日本語" },
  ];
  assert.deepEqual(normalizeQuickPhrases(phrases), phrases);
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

// --- Voreinstellungen -----------------------------------------------------
// Der Kern dieser Tests ist nicht die Zahl der Defaults, sondern dass sie genau
// einmal gesaet werden. "Einmal sehen, nie wieder aufstehen": wer alle loescht,
// bekommt sie nicht ungefragt zurueck.

test("the defaults have the documented labels, in order", () => {
  assert.deepEqual(
    DEFAULT_QUICK_PHRASES.map((phrase) => phrase.label),
    ["Research", "Compare", "Verify", "Explain", "Review", "Tests", "Fix"],
  );
  for (const phrase of DEFAULT_QUICK_PHRASES) {
    assert.equal(phrase.text.startsWith(" "), false, `kein fuehrendes Leerzeichen: ${phrase.label}`);
    assert.equal(phrase.text.trim(), phrase.text, `keine Randleerzeichen: ${phrase.label}`);
    assert.ok(phrase.text.length > 0);
  }
});

test("the defaults validate as they are", () => {
  // Sie gehen unveraendert in die Datei. Ein Default, der die eigene
  // Validierung nicht besteht, waere beim ersten Schreiben weg.
  assert.deepEqual(normalizeQuickPhrases(DEFAULT_QUICK_PHRASES), DEFAULT_QUICK_PHRASES);
});

// --- Migration aus dem Browser -------------------------------------------
// Dieselbe Drei-Faelle-Regel wie vor dem Umbau, nur gelesen statt geschrieben:
// was da ist, gehoert dem Nutzer und wird nicht ueberschrieben.

test("both legacy keys missing means never set up, so seeding is allowed", () => {
  const storage = createStorage();

  const legacy = readLegacyQuickPhrases(storage);
  assert.equal(legacy.needsSeed, true);
  assert.deepEqual(legacy.phrases, DEFAULT_QUICK_PHRASES);
});

test("the flag set with an emptied list is a decision, not an unconfigured browser", () => {
  // Der Nutzer hat alles geloescht. Nachziehen wuerde genau das zuruecknehmen,
  // worum es beim Flag geht.
  const storage = createStorage({ "omp-quick-phrases-seeded": "1" });

  const legacy = readLegacyQuickPhrases(storage);
  assert.equal(legacy.needsSeed, false);
  assert.deepEqual(legacy.phrases, []);
});

test("phrases from the older version are migrated, not seeded over", () => {
  // Der schlimmste Fehler eines Seeds: beim ersten Lesen gespeicherte eigene
  // Phrasen ueberschreiben, bevor der Nutzer sie je wieder gesehen hat.
  const kept = [{ label: "Meine", text: "Nur diese eine." }];
  const storage = createStorage({ "omp-quick-phrases": JSON.stringify(kept) });

  const legacy = readLegacyQuickPhrases(storage);
  assert.equal(legacy.needsSeed, false);
  assert.deepEqual(legacy.phrases, kept);
});

test("an emptied list from the older version is migrated as empty", () => {
  const storage = createStorage({ "omp-quick-phrases": JSON.stringify([]) });

  const legacy = readLegacyQuickPhrases(storage);
  assert.equal(legacy.needsSeed, false);
  assert.deepEqual(legacy.phrases, []);
});

test("unreadable legacy content is migrated as empty instead of being seeded over", () => {
  const storage = createStorage({ "omp-quick-phrases": "{kein json" });

  const legacy = readLegacyQuickPhrases(storage);
  assert.equal(legacy.needsSeed, false);
  assert.deepEqual(legacy.phrases, []);
});

test("without a browser storage the defaults apply", () => {
  assert.deepEqual(readLegacyQuickPhrases(null), {
    phrases: DEFAULT_QUICK_PHRASES,
    needsSeed: true,
  });
});

test("a blocked storage still yields the defaults instead of an empty row", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    removeItem() { throw new DOMException("blocked", "SecurityError"); },
  };

  assert.deepEqual(readLegacyQuickPhrases(blocked), {
    phrases: DEFAULT_QUICK_PHRASES,
    needsSeed: true,
  });
  // Und das Loeschen der Altlasten darf daran nicht scheitern.
  assert.doesNotThrow(() => clearLegacyQuickPhrases(blocked));
});

test("the legacy keys are removed after a successful migration", () => {
  const storage = createStorage({ "omp-quick-phrases": "[]", "omp-quick-phrases-seeded": "1" });

  clearLegacyQuickPhrases(storage);

  assert.equal(storage.getItem("omp-quick-phrases"), null);
  assert.equal(storage.getItem("omp-quick-phrases-seeded"), null);
});

test("clearing without a storage does not crash", () => {
  assert.doesNotThrow(() => clearLegacyQuickPhrases(null));
});

// --- Spiegel gegen einen Ausfall -----------------------------------------
// Der Spiegel ist eine Anzeige-Sicherung fuer genau einen Fall: die Seite wird
// neu geladen, waehrend der Server nicht antwortet.

test("the mirror keeps a loaded list for a reload during an outage", () => {
  const storage = createStorage();
  const phrases = [{ label: "Bleibt da", text: "Dieser Text bleibt sichtbar" }];

  writeQuickPhrasesMirror(phrases, storage);

  assert.deepEqual(readQuickPhrasesMirror(storage), phrases);
});

test("no mirror means no list, not the defaults", () => {
  // Bei einem Ausfall die Defaults zu zeigen hiesse dem Nutzer, seine Phrasen
  // seien weg — und wuerde sie beim naechsten Schreibvorgang wirklich loeschen.
  assert.equal(readQuickPhrasesMirror(createStorage()), null);
  assert.equal(readQuickPhrasesMirror(null), null);
});

test("an unreadable mirror is no mirror", () => {
  assert.equal(readQuickPhrasesMirror(createStorage({ "omp-quick-phrases-mirror": "{kein json" })), null);
});

test("the mirror is rewritten when the list changes, and left alone when it does not", () => {
  const storage = createStorage();
  const phrases = [{ label: "A", text: "hier" }];
  writeQuickPhrasesMirror(phrases, storage);
  const writes = [];
  const counting = { ...storage, setItem: (k, v) => { writes.push(v); storage.setItem(k, v); } };

  writeQuickPhrasesMirror(phrases, counting);
  assert.deepEqual(writes, [], "gleicher Stand darf keinen Schreibvorgang ausloesen");

  writeQuickPhrasesMirror([{ label: "B", text: "anders" }], counting);
  assert.equal(writes.length, 1);
  assert.deepEqual(readQuickPhrasesMirror(counting), [{ label: "B", text: "anders" }]);
});

test("a blocked storage does not break writing or reading the mirror", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
    removeItem() { throw new DOMException("blocked", "SecurityError"); },
  };

  assert.doesNotThrow(() => writeQuickPhrasesMirror([{ label: "A", text: "b" }], blocked));
  assert.equal(readQuickPhrasesMirror(blocked), null);
  assert.doesNotThrow(() => writeQuickPhrasesMirror([{ label: "A", text: "b" }], null));
});

test("clearing the legacy keys leaves the mirror alone", () => {
  // Der Spiegel ist die Anzeige-Sicherung, keine Migrationsreste: wer ihn mit
  // aufraeumt, verliert genau den Fall, fuer den er da ist.
  const storage = createStorage({
    "omp-quick-phrases": "[]",
    "omp-quick-phrases-seeded": "1",
    "omp-quick-phrases-mirror": JSON.stringify([{ label: "A", text: "b" }]),
  });

  clearLegacyQuickPhrases(storage);

  assert.deepEqual(readQuickPhrasesMirror(storage), [{ label: "A", text: "b" }]);
});