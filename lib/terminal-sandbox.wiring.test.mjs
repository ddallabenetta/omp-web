import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
const listRoute = readFileSync(new URL("../app/api/terminal/route.ts", import.meta.url), "utf8");
const itemRoute = readFileSync(new URL("../app/api/terminal/[id]/route.ts", import.meta.url), "utf8");

/**
 * Die Verdrahtung zwischen Manager, Sandbox und HTTP-Antwort.
 *
 * Die Laufzeitpruefung von `lib/sandbox.test.mjs` deckt das *Modul* ab. Hier
 * geht es um die drei Nahte, die sonst niemand sieht: dass `spawn()` die
 * Sandbox ueberhaupt benutzt, dass das Admin-Passwort nicht in die Shell
 * wandert, und dass die API sagt, ob isoliert wurde. Ein Refactor, der eines
 * davon loest, laeuft durch alle anderen Tests hindurch — die Shell waere dann
 * nur noch scheinbar isoliert, oder die Antwort wuerde es nicht zugeben.
 */
test("spawn() baut die Shell ueber den Sandbox-Plan, nicht als nackten Prozess", () => {
  assert.match(manager, /checkSandboxPrerequisites\(/);
  assert.match(manager, /planSandboxSpawn\(/);
  // `cmd = plan.argv` ist der Punkt, an dem aus "Voraussetzungen vorhanden"
  // eine tatsaechlich sandboxte Shell wird.
  assert.match(manager, /cmd = plan\.argv/);
  // Das Admin-Passwort darf nicht in die Mandanten-Shell durchgereicht werden.
  assert.match(manager, /delete env\.OMP_WEB_PASSWORD/);
});

test("die API nennt, ob eine Shell wirklich sandboxed ist", () => {
  // Beide Serialisierungen, sonst sieht ein Client je nach Route etwas
  // anderes. Der Schluessel muss vorhanden sein, nicht nur deklariert.
  assert.match(listRoute, /sandboxed: info\.sandboxed/);
  assert.match(itemRoute, /sandboxed: info\.sandboxed/);
  assert.match(manager, /sandboxed,/);
});
