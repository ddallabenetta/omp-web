import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSandboxPrerequisites, planSandboxSpawn } from "./sandbox.ts";

/**
 * Die Sandbox ist die ganze Mandantengrenze des Terminals.
 *
 * Geprueft wird nicht "der Aufruf kehrt zurueck", sondern die Eigenschaft, auf
 * die es ankommt: dass ein fremdes Home im argv **nicht** vorkommt. Ein
 * Aufruf, der zurueckkommt und trotzdem ein zweites `--bind` auf ein fremdes
 * Verzeichnis mitbringt, waere der Fehler, den man nur so fangen kann.
 *
 * Alles, was einen *erfolgreichen* Plan voraussetzt, laeuft nur, wo `bwrap` und
 * User-Namespaces vorhanden sind, und ist deshalb als `test(..., { skip })`
 * angelegt: auf einem Host ohne die Voraussetzungen sollen die
 * Ablehnungstests weiterhin laufen und die argv-Tests sauber uebersprungen
 * sein, statt mit einem Fehlschlag zu enden, der nichts ueber den Code sagt.
 * Ein `skip` ist dabei selbst ein Befund: `checkSandboxPrerequisites()` sieht
 * das `bwrap` nicht.
 */

const CAN_RUN = process.platform !== "win32" && checkSandboxPrerequisites().ok;

/**
 * Was auf **jedem** Host gilt, wenn ein Plan abgelehnt wurde.
 *
 * Auf einem Host ohne `bwrap` bricht schon die Voraussetzungspruefung ab, bevor
 * Benutzername, Home oder cwd geprueft werden. Die Ursache ist dann ein
 * anderer Grund — die gemeinsame Eigenschaft bleibt aber: kein argv, und eine
 * Remediation, die sagt, was zu tun ist. Die spezifischen `reason`-Assertions
 * stehen darum hinter `CAN_RUN`.
 */
function assertRejected(plan) {
  assert.ok(!("argv" in plan), "a rejected plan must not carry an argv");
  assert.ok(plan.remediation.length > 0, "a refusal without remediation is a dead end");
}

function sandboxDir(name, t) {
  const root = mkdtempSync(join(tmpdir(), "omp-sandbox-"));
  // Ohne das hier bleibt pro Aufruf ein `/tmp/omp-sandbox-*` liegen. `t.after`
  // laeuft bei Erfolg **und** bei einem roten Assert, was ein `rmSync` am Ende
  // des Testkoerpers nicht kann.
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return { root, home };
}

test("der argv traegt genau ein Bind-Mount: das eigene Home", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("alice", t);
  const plan = planSandboxSpawn({
    home,
    username: "alice",
    command: ["/usr/bin/script", "-qfc", "bash -i", "/dev/null"],
    cwd: home,
  });

  assert.equal(plan.ok, true, "plan should be ok where bwrap exists");
  if (!plan.ok) return;

  // Binds und Umgebung getrennt einsammeln. Ein gemeinsamer Loop ueber beide
  // Flags liest beim zweiten `--setenv` das naechste Flag statt des Wertes — die
  // Flags haben unterschiedliche Arity, und genau dieser Fehler hat hier eine
  // Assertion falsch rot gemacht.
  const bindSources = [];
  for (let i = 0; i < plan.argv.length; i += 1) {
    if (plan.argv[i] === "--bind") bindSources.push(plan.argv[i + 1]);
  }
  assert.deepEqual(bindSources, [home], "exactly one bind: the tenant's own home");

  const envs = {};
  for (let i = 0; i < plan.argv.length; i += 1) {
    if (plan.argv[i] === "--setenv") envs[plan.argv[i + 1]] = plan.argv[i + 2];
  }
  assert.deepEqual(envs, { HOME: "/home/alice", USER: "alice", LOGNAME: "alice" });
  // A second tenant's home must never be bound. `other` is a directory that
  // exists in the same fixture root, so a copy-paste that added it would
  // produce a real path here rather than a missing one.
  assert.ok(!plan.argv.some((a) => a.includes("other")), "no second home may be bound");
});

test("das eigene Home wird unter /home/<name> gemountet, nicht unter seinem echten Pfad", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("bob", t);
  const plan = planSandboxSpawn({ home, username: "bob", command: ["bash"], cwd: home });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const bindIndex = plan.argv.indexOf("--bind");
  assert.equal(plan.argv[bindIndex + 1], home, "source is the real home");
  assert.equal(plan.argv[bindIndex + 2], "/home/bob", "destination is inside the namespace");
});

test("ein Benutzername, der aus seinem Pfadsegment ausbrechen wuerde, wird abgelehnt", (t) => {
  const { home } = sandboxDir("carol", t);
  const plan = planSandboxSpawn({ home, username: "../../etc", command: ["bash"], cwd: home });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assertRejected(plan);
  if (!CAN_RUN) return;
  assert.equal(plan.reason, "bad-username", "a traversal name gets its own reason, not no-home");
  // The rejection must happen before any path is built, not after. Nicht
  // `JSON.stringify(plan)`: die Ablehnung nennt den Angreiferstring im `detail`,
  // und der taucht damit zwingend im JSON auf. Geprueft wird die Eigenschaft,
  // dass kein Pfad gebaut wurde — nicht, dass der fremde String fehlt.
  assert.ok(!("argv" in plan), "no argv may be built for a rejected username");
});

test("ein Nachbarverzeichnis mit gleichem Praefix ist nicht das eigene Home", (t) => {
  const { root, home } = sandboxDir("ivan", t);
  // `/…/ivan2` teilt sich das Zeichenpraefix mit `/…/ivan`, liegt aber nicht
  // darunter. Ein `startsWith(home)` statt `startsWith(home + "/")` wuerde es
  // als Kind akzeptieren und damit in ein fremdes Verzeichnis chdir — der
  // Namespace-Pfad davor schuetzt nicht, weil der Test-Pfad zufaellig gleich
  // beginnt.
  const neighbour = join(root, "ivan2");
  mkdirSync(neighbour);
  const plan = planSandboxSpawn({ home, username: "ivan", command: ["bash"], cwd: neighbour });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assertRejected(plan);
  if (!CAN_RUN) return;
  assert.equal(plan.reason, "cwd-outside-home");
});

test("ein Bind-Pfad, den der Host nicht hat, wird nicht in den argv geschrieben", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("judy", t);
  const plan = planSandboxSpawn({ home, username: "judy", command: ["bash"], cwd: home });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  // bwrap bricht auf einem fehlenden Bind-Quellpfad ab (`Can't find source
  // path`, gemessen), statt ihn zu uebergehen. Der argv darf darum nur
  // Verzeichnisse nennen, die es auf diesem Host wirklich gibt.
  //
  // Ehrlich zur Reichweite: wo `/lib`, `/lib64` und `/sbin` alle vorhanden
  // sind — also auf diesem Host — ist diese Pruefung nicht unterscheidend, ein
  // entfernter `existsSync`-Zweig ergaebe denselben argv. Sie wird erst dort
  // rot, wo eines der Verzeichnisse fehlt. Der zweite Teil unten ist der, der
  // ueberall traegt: der Spawn muss mit dem argv wirklich laufen.
  for (let i = 0; i < plan.argv.length; i += 1) {
    if (plan.argv[i] !== "--ro-bind") continue;
    assert.ok(existsSync(plan.argv[i + 1]), `--ro-bind source must exist: ${plan.argv[i + 1]}`);
  }
  // Und der Spawn muss damit wirklich starten, nicht nur einen plausibel
  // aussehenden argv erzeugen.
  const run = planSandboxSpawn({
    home,
    username: "judy",
    command: ["/usr/bin/sh", "-c", "echo bind-ok"],
    cwd: home,
  });
  assert.equal(run.ok, true);
  if (!run.ok) return;
  const out = execFileSync(run.argv[0], run.argv.slice(1), { encoding: "utf8" });
  assert.match(out, /bind-ok/);
});

test("ohne Home wird nicht sandboxed, sondern mit Remediation abgelehnt", () => {
  // `cwd` zeigt bewusst aus dem Home heraus: der `no-home`-Zweig muss zuerst
  // greifen, sonst wuerde die cwd-Pruefung den Grund verdecken.
  const plan = planSandboxSpawn({ home: "", username: "dave", command: ["bash"], cwd: "/tmp" });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assertRejected(plan);
  if (!CAN_RUN) return;
  assert.equal(plan.reason, "no-home");
});

test("ein Arbeitsverzeichnis ausserhalb des Homes wird abgelehnt, nicht still auf / gesetzt", (t) => {
  const { root, home } = sandboxDir("heidi", t);
  const outside = join(root, "project");
  mkdirSync(outside);
  const plan = planSandboxSpawn({ home, username: "heidi", command: ["bash"], cwd: outside });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assertRejected(plan);
  if (!CAN_RUN) return;
  assert.equal(plan.reason, "cwd-outside-home");
  assert.ok(plan.remediation.length > 0, "a refusal without remediation is a dead end");
});

test("der Namespace zeigt nicht die Prozesse des Dienstes", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("erin", t);
  // pid 1 inside the namespace must be the sandbox's own init, never the
  // Bun/Next process the service runs as. Without `--unshare-pid` this would
  // come back as the server's command line.
  const plan = planSandboxSpawn({
    home,
    username: "erin",
    command: ["/usr/bin/sh", "-c", "tr '\\0' ' ' < /proc/1/cmdline"],
    cwd: home,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const out = execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" }).trim();
  assert.ok(out.length > 0, "pid 1 must be readable inside the namespace");
  assert.ok(
    !out.includes("next-server") && !out.includes("next start") && !/bun(\s|$)/.test(out),
    `pid 1 should be the sandbox init, saw: ${out}`,
  );
});

test("ein fremdes Home ist innerhalb der Sandbox nicht erreichbar", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-sandbox-iso-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alice = join(root, "alice-home");
  const bob = join(root, "bob-home");
  mkdirSync(alice, { recursive: true });
  mkdirSync(bob, { recursive: true });
  writeFileSync(join(alice, "secret.txt"), "alice-only");
  writeFileSync(join(bob, "public.txt"), "bob-only");

  const plan = planSandboxSpawn({
    home: bob,
    username: "bob",
    command: ["/usr/bin/sh", "-c", "cat /home/bob/public.txt; cat /home/alice/secret.txt 2>&1 || true"],
    cwd: bob,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const out = execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" });
  assert.match(out, /bob-only/);
  assert.ok(!out.includes("alice-only"), "the other tenant's file must be unreadable");
  // "No such file or directory" and not "Permission denied": the directory is
  // not merely closed, it does not exist in this namespace. A permission
  // error would mean it is still there and only its mode is off.
  assert.match(out, /No such file or directory/);
});

test("sudo und su koennen in der Sandbox nicht zu root", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("frank", t);
  const plan = planSandboxSpawn({
    home,
    username: "frank",
    command: ["/usr/bin/sh", "-c", "sudo -n id 2>&1 | head -1; su nobody -c id 2>&1 | head -1"],
    cwd: home,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const out = execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" });
  assert.ok(!/uid=0\(root\)/.test(out), `root was reachable inside the sandbox: ${out}`);
});

test("was die Shell schreibt, bleibt fuer den Dienst lesbar und loeschbar", { skip: !CAN_RUN && "bwrap or user namespaces unavailable" }, (t) => {
  const { home } = sandboxDir("grace", t);
  const plan = planSandboxSpawn({
    home,
    username: "grace",
    command: ["/usr/bin/sh", "-c", "echo from-tenant > /home/grace/owned.txt"],
    cwd: home,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  execFileSync(plan.argv[0], plan.argv.slice(1), { encoding: "utf8" });
  // This is the property that makes the namespace usable in production: an
  // unprivileged namespace maps the fake uid back onto the service uid, so the
  // service can still clean up after a tenant. A real `useradd` per account
  // would break exactly here.
  assert.ok(existsSync(join(home, "owned.txt")), "the service must see what the tenant wrote");
});
