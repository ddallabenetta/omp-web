import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getQuickPhrasesPath,
  isQuickPhrasesPathAllowed,
  readQuickPhrasesFile,
  writeQuickPhrasesFile,
} = await jiti.import("./quick-phrases-store.ts");

/**
 * Mandantentrennung und Ablage der Phrasendatei.
 *
 * Der Test laeuft gegen echte Dateien in einem temporaeren Home, weil genau der
 * Dateisystemzugriff das ist, was getrennt sein muss. Ein Test gegen eine
 * gemockte `fs` prueft die Property, die man ausschliesst: dass Nutzer A den
 * Pfad von Nutzer B ueberhaupt nicht erreicht.
 *
 * `resolveTenantAgentDir` liest `OMP_WEB_HOME_ROOT` ueber `process.env`, also
 * wird es hier um das temporaere Wurzelverzeichnis gesetzt und danach
 * zurueckgesetzt — ein stehengebliebenes `env` wuerde den Rest der Suite auf
 * einem Wegweiser ins Leere laufen lassen.
 */
function withHome(fn) {
  const previous = process.env.OMP_WEB_HOME_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omp-web-quick-phrases-"));
  process.env.OMP_WEB_HOME_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_HOME_ROOT;
    else process.env.OMP_WEB_HOME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const alice = { username: "alice", isAdmin: false };
const bob = { username: "bob", isAdmin: false };

test("two accounts get two files, each named after its owner", () => withHome((root) => {
  const alicePath = getQuickPhrasesPath(alice);
  const bobPath = getQuickPhrasesPath(bob);

  assert.notEqual(alicePath, bobPath);
  assert.ok(alicePath.startsWith(join(root, "alice")), alicePath);
  assert.ok(bobPath.startsWith(join(root, "bob")), bobPath);
}));

test("one account cannot read another account's phrases", () => withHome(() => {
  writeQuickPhrasesFile(alice, [{ label: "A", text: "Nur Alice" }]);

  assert.deepEqual(readQuickPhrasesFile(alice).phrases, [{ label: "A", text: "Nur Alice" }]);
  // Bobs Datei existiert nicht; er sieht seinen eigenen leeren Zustand und
  // nicht Alices Liste.
  assert.deepEqual(readQuickPhrasesFile(bob), { exists: false, phrases: [] });
}));

test("one account cannot overwrite another account's phrases", () => withHome(() => {
  writeQuickPhrasesFile(alice, [{ label: "A", text: "Nur Alice" }]);
  const alicePath = getQuickPhrasesPath(alice);
  const before = readFileSync(alicePath, "utf8");

  // Bob schreibt. Der Aufruf nimmt nur eine Liste entgegen, keinen Pfad —
  // der Weg zu Alices Datei existiert in diesem Modul nicht.
  writeQuickPhrasesFile(bob, [{ label: "B", text: "Nur Bob" }]);

  assert.equal(readFileSync(alicePath, "utf8"), before);
  assert.deepEqual(readQuickPhrasesFile(alice).phrases, [{ label: "A", text: "Nur Alice" }]);
  assert.deepEqual(readQuickPhrasesFile(bob).phrases, [{ label: "B", text: "Nur Bob" }]);
}));

test("the file must stay inside the account home", () => withHome((root) => {
  const path = getQuickPhrasesPath(alice);
  assert.ok(isQuickPhrasesPathAllowed(alice, path));

  // Fremde Home, Ausbruch aus der eigenen Home, Systempfad: alle abgelehnt.
  assert.equal(isQuickPhrasesPathAllowed(alice, join(root, "bob", "phrases.json")), false);
  assert.equal(isQuickPhrasesPathAllowed(alice, join(root, "alice", "..", "bob")), false);
  assert.equal(isQuickPhrasesPathAllowed(alice, "/etc/phrases.json"), false);
}));

test("roundtrips umlauts and multi-line text", () => withHome(() => {
  const phrases = [
    { label: "Grüße", text: "Zeile eins\nZeile zwei" },
    { label: "日本語", text: "改行\n\tmit Tab" },
    { label: "", text: "plain" },
  ];

  assert.deepEqual(writeQuickPhrasesFile(alice, phrases), phrases);
  assert.deepEqual(readQuickPhrasesFile(alice).phrases, phrases);
}));

test("entries without text are dropped on write, not stored", () => withHome(() => {
  const saved = writeQuickPhrasesFile(alice, [
    { label: "leer", text: "" },
    { label: "kein text" },
    { label: "gut", text: "hier" },
    "nur ein string",
  ]);

  assert.deepEqual(saved, [{ label: "gut", text: "hier" }]);
  const onDisk = JSON.parse(readFileSync(getQuickPhrasesPath(alice), "utf8"));
  assert.deepEqual(onDisk.phrases, [{ label: "gut", text: "hier" }]);
}));

test("an emptied list stays empty instead of being topped up", () => withHome(() => {
  writeQuickPhrasesFile(alice, []);
  // `exists: true` ist der Unterschied: die Datei da ist, der Nutzer hat
  // entschieden. Genau deshalb wird nie wieder gesaet.
  assert.deepEqual(readQuickPhrasesFile(alice), { exists: true, phrases: [] });
}));

test("unreadable content is an existing empty list, so no seed can overwrite it", () => withHome(() => {
  const path = getQuickPhrasesPath(alice);
  writeQuickPhrasesFile(alice, [{ label: "A", text: "Nur Alice" }]);
  writeFileSync(path, "{kein json");

  assert.deepEqual(readQuickPhrasesFile(alice), { exists: true, phrases: [] });
}));

test("the file is private to the process account", () => withHome(() => {
  writeQuickPhrasesFile(alice, [{ label: "A", text: "Nur Alice" }]);
  // 0o600 aus `writePrivateFileAtomicSync`.
  assert.equal(statSync(getQuickPhrasesPath(alice)).mode & 0o777, 0o600);
}));