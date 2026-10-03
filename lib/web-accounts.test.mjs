import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const store = createRequire(import.meta.url)("../bin/web-auth-store.js");

/**
 * Der Mehrbenutzer-Store.
 *
 * Drei Dinge sind einen dauerhaften Test wert, und keines davon ist "die API
 * liefert wie vorher":
 *
 *  1. Ein Benutzername wird zu einem Pfadsegment. Ein Name, der aus diesem
 *     Segment ausbrechen wuerde, muss abgelehnt werden, **bevor** etwas angelegt
 *     wird. Ein Test, der nur die Fehlermeldung prueft, bestaende auch dann das
 *     Richtige, wenn das Verzeichnis schon stuende.
 *  2. Das Admin-Kennzeichen wird bei jedem Lesen aus dem Namen berechnet. Ein
 *     Eintrag, der sich auf der Platte als Admin eintragen laesst, kann sich
 *     dadurch nicht selbst hochstufen.
 *  3. Ein halb angelegtes Konto — Verzeichnis ohne Eintrag oder umgekehrt —
 *     sperrt jemanden aus seinem eigenen Home aus.
 */

/** Haelt scrypt billig: diese Tests pruefen das Protokoll, nicht den Kostfaktor. */
const PARAMS = { cost: 16, keyLength: 32 };
const PASSWORD = "a-long-enough-password";

function withAccounts(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-accounts-"));
  const homeRoot = join(dir, "home");
  mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const options = {
    env: { OMP_WEB_HOME_ROOT: homeRoot },
    file: join(dir, "omp-web-auth.json"),
    accountsFile: join(dir, "omp-web-accounts.json"),
    params: PARAMS,
  };
  try {
    return run(options, homeRoot, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("legt Konto, Home-Verzeichnis und nichts im Klartext an", () => {
  withAccounts((options, homeRoot) => {
    const account = store.createWebAccount("alice", PASSWORD, options);

    assert.equal(account.username, "alice");
    assert.equal(account.home, join(homeRoot, "alice"));
    assert.equal(existsSync(join(homeRoot, "alice")), true);
    // 0700: dieses Verzeichnis ist die einzige echte Grenze hier.
    assert.equal(statSync(join(homeRoot, "alice")).mode & 0o777, 0o700);

    const contents = readFileSync(options.accountsFile, "utf8");
    assert.equal(contents.includes(PASSWORD), false);
    assert.equal(JSON.parse(contents).users[0].password.algorithm, "scrypt");
  });
});

/**
 * Die Sicherheitseigenschaft: ein Name, der kein einzelnes Pfadsegment ist,
 * wird abgelehnt, und es entsteht nichts. Die Pruefung des Verzeichnisses
 * danach ist der eigentliche Test — die Validierung findet statt, damit genau
 * das nicht passiert.
 */
test("lehnt einen Namen ab, der aus dem Home-Wurzelraum ausbrechen wuerde", () => {
  withAccounts((options, homeRoot) => {
    for (const name of ["../etc", "a/b", "..", "../../root", "/absolute", "a b", "MiXeD", "-lead", "a\0b", ""]) {
      assert.notEqual(store.validateAccountName(name), null, `akzeptiert: ${JSON.stringify(name)}`);
      assert.throws(
        () => store.createWebAccount(name, PASSWORD, options),
        `angelegt: ${JSON.stringify(name)}`,
      );
    }

    // Nichts entstanden: kein Ausbruch, kein Teilename, gar nichts.
    assert.deepEqual(readdirSync(homeRoot), []);
  });
});

test("leitet isAdmin bei jedem Lesen aus dem Namen ab, nicht aus der Datei", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    store.createWebAccount("steimerbyte", PASSWORD, options);

    const listed = store.listWebAccounts(options).accounts;
    assert.deepEqual(
      listed.map((account) => [account.username, account.isAdmin]),
      [["alice", false], ["steimerbyte", true]],
    );

    // Die Datei von Hand auf root umschreiben. Ein gespeichertes Flag wuerde
    // geglaubt, ein abgeleitetes nicht.
    const raw = JSON.parse(readFileSync(options.accountsFile, "utf8"));
    raw.users[0].isAdmin = true;
    writeFileSync(options.accountsFile, JSON.stringify(raw));

    const afterEdit = store.listWebAccounts(options).accounts;
    assert.equal(afterEdit.find((account) => account.username === "alice").isAdmin, false);
  });
});

test("OMP_WEB_ADMINS ueberschreibt die Vorgabeliste", () => {
  withAccounts((options, homeRoot) => {
    const scoped = { ...options, env: { OMP_WEB_HOME_ROOT: homeRoot, OMP_WEB_ADMINS: "alice, bob" } };
    store.createWebAccount("alice", PASSWORD, scoped);
    store.createWebAccount("omp", PASSWORD, scoped);

    const listed = store.listWebAccounts(scoped).accounts;
    assert.deepEqual(
      listed.map((account) => [account.username, account.isAdmin]),
      [["alice", true], ["omp", false]],
    );
  });
});

test("ein deaktiviertes Konto meldet sich nicht an, sein Home bleibt", () => {
  withAccounts((options, homeRoot) => {
    store.createWebAccount("alice", PASSWORD, options);
    assert.ok(store.findWebAccount("alice", options));

    store.setWebAccountEnabled("alice", false, options);
    assert.equal(store.findWebAccount("alice", options), null);
    // Das Home ueberlebt die Sperre: ein Admin soll es nicht neu anlegen
    // muessen, nur weil jemand das Konto abgeschaltet hat.
    assert.equal(existsSync(join(homeRoot, "alice")), true);

    store.setWebAccountEnabled("alice", true, options);
    assert.ok(store.findWebAccount("alice", options));
  });
});

test("eine Passwortrotation macht das alte Passwort unbrauchbar", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    const first = store.findWebAccount("alice", options).password.hash;

    store.setWebAccountPassword("alice", "a-different-password", options);
    const second = store.findWebAccount("alice", options).password.hash;

    assert.notEqual(first, second);
  });
});

test("ein doppelter Name und ein belegtes Home werden beide abgelehnt", () => {
  withAccounts((options, homeRoot) => {
    store.createWebAccount("alice", PASSWORD, options);
    assert.throws(() => store.createWebAccount("alice", PASSWORD, options), Error, /already exists/);

    // Ein Verzeichnis ohne Eintrag: den Namen zu uebernehmen wuerde ein
    // fremdes Home an eine Zugangsberechtigung binden, die nie erteilt wurde.
    mkdirSync(join(homeRoot, "bob"), { recursive: true });
    assert.throws(() => store.createWebAccount("bob", PASSWORD, options), Error, /already exists/);
  });
});

test("eine kaputte Kontendatei verweigert Schreibzugriffe statt die Liste zu verwerfen", () => {
  withAccounts((options) => {
    store.createWebAccount("alice", PASSWORD, options);
    writeFileSync(options.accountsFile, "{ not json");

    const state = store.listWebAccounts(options);
    assert.equal(state.status, "unreadable");
    // Das stillschweigend als "keine Konten" zu lesen wuerde beim naechsten
    // Anlegen eine frische Datei schreiben und alle Vorhandenen verwaisen lassen.
    assert.throws(() => store.createWebAccount("bob", PASSWORD, options), Error, /could not be read/);
  });
});

test("Credential-Datei und Kontendatei bleiben getrennt", () => {
  withAccounts((options) => {
    store.setWebPassword(PASSWORD, options);
    store.createWebAccount("alice", PASSWORD, options);

    // Ein `file`-Feld, zwei Dokumente. Sie duerfen nicht kollidieren.
    const credential = JSON.parse(readFileSync(options.file, "utf8"));
    const accounts = JSON.parse(readFileSync(options.accountsFile, "utf8"));
    assert.equal(credential.users, undefined);
    assert.equal(accounts.version, 1);
    assert.equal(accounts.users.length, 1);
  });
});

/**
 * Die Vorabpruefung von `OMP_WEB_HOME_ROOT`.
 *
 * Ohne sie bricht die Kontoanlage mit einem nackten `EACCES: permission
 * denied, mkdir '/home/probe'` ab — dem Admin sagt das nicht, **wo** er es
 * aendern soll. Geprueft wird deshalb beides: dass ein brauchbares Wurzelverzeichnis
 * angenommen wird, und dass ein unbrauchbares eine Remediation liefert, die
 * `OMP_WEB_HOME_ROOT` nennt.
 */
function withHomeRoot(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-home-root-"));
  try {
    return run(dir);
  } finally {
    // Die Tests setzen absichtlich unbeschreibbare Rechte. Ohne das Ruecksetzen
    // schlaegt `rm` des Wurzelverzeichnisses mit `EACCES` fehl und der Fehler
    // landet im `finally` statt in der Assertion, die ihn ausloesen sollte.
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fuehrt `run` mit vertaeuschter uid/Gruppenzugehoerigkeit aus.
 *
 * Nötig fuer den Gruppen-Schreibrecht-Zweig: ein Verzeichnis, das einer Gruppe
 * gehoert, in der der Dienst ist, muss sich von einem ablehnen lassen, das nur
 * `world`-Schreibrecht hat. Beides geht nicht mit einer echten fremden uid, weil
 * dann `chown` noetig waere — weder hier noch in CI (ubuntu-latest laeuft als
 * uid 1001). Der Patch ist auf den Aufruf begrenzt und im `finally` garantiert
 * zurueckgesetzt, damit kein folgender Test eine falsche Identitaet sieht.
 */
function withFakeUser({ getuid, getgroups }, run) {
  const original = { getuid: process.getuid, getgroups: process.getgroups };
  process.getuid = getuid;
  process.getgroups = getgroups;
  try {
    return run();
  } finally {
    process.getuid = original.getuid;
    process.getgroups = original.getgroups;
  }
}

test("eine brauchbare Wurzel wird akzeptiert, eine ohne Eltern nicht", () => {
  withHomeRoot((dir) => {
    // Der Normalfall: das Wurzelverzeichnis existiert bereits und gehoert dem
    // Dienst. Ein schreibgeschuetztes Elternverzeichnis ist dabei egal — es wird
    // nichts mehr erstellt, nur noch hineingeschrieben.
    const root = join(dir, "accounts");
    mkdirSync(root);
    assert.deepEqual(store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: root }), { ok: true, root });

    const missingParent = store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: join(dir, "nope", "accounts") });
    assert.equal(missingParent.ok, false);
    assert.match(missingParent.remediation, /OMP_WEB_HOME_ROOT/);

    // Ein Elternteil, das eine Datei ist: `mkdir` wuerde mit ENOTDIR abbrechen.
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    const parentIsFile = store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: join(file, "accounts") });
    assert.equal(parentIsFile.ok, false);
    assert.match(parentIsFile.remediation, /OMP_WEB_HOME_ROOT/);

    // Zuletzt das schreibgeschuetzte Elternverzeichnis — erst nach dem Anlegen
    // aller Fixtures, sonst waere `dir` selbst nicht mehr beschreibbar.
    chmodSync(dir, 0o500);
    assert.deepEqual(store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: root }), { ok: true, root });
  });
});

test("ein sticky Wurzelverzeichnis wird abgelehnt, ein world-writable nicht", () => {
  withHomeRoot((dir) => {
    // 1777 wie /tmp: anlegen ginge, aber ein liegengebliebenes Home koennte der
    // Dienst danach nicht mehr wegraeumen. `mkdir`-Modi laufen durch die umask
    // (hier 022), deshalb wird die Rechtecke gesetzt statt im `mode` zu hoffen.
    //
    // Geprueft wird das fuer einen *fremden* Besitzer: `isWritableDirectory`
    // gibt dem Besitzer sofort recht, und ein 1777-Verzeichnis in eigener Hand
    // ist auch in Wahrheit benutzbar. Der Sticky-Ablehnungsfall ist genau der,
    // in dem jemand anderes besitzt.
    const sticky = join(dir, "sticky");
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    const stickyResult = withFakeUser({ getuid: () => 9999, getgroups: () => [process.getgid()] }, () =>
      store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: sticky }));
    assert.equal(stickyResult.ok, false);
    assert.match(stickyResult.remediation, /OMP_WEB_HOME_ROOT/);

    // 0777 ohne Sticky ist ein legitimer gemeinsamer Dienst-Wurzelbaum.
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    assert.equal(store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: shared }).ok, true);
  });
});

test("Gruppen-Schreibrecht macht ein Verzeichnis zur brauchbaren Wurzel", () => {
  withHomeRoot((dir) => {
    const parent = join(dir, "group-owned");
    mkdirSync(parent);
    // Ohne `chmod` bliebe es bei 0750: die umask 022 nimmt dem `mkdir` das
    // Gruppen-Schreibrecht, und der Test pruefte dann nichts.
    chmodSync(parent, 0o770);

    // Ein 0o770-Verzeichnis, das einer Gruppe gehoert, in der der Dienst ist,
    // ist genauso benutzbar wie eines in eigener Hand. Der Test muss das
    // gegen eine fremde uid pruefen, sonst faellt er auch ohne den
    // Gruppenzweig durch (`uid === stat.uid` traegt).
    const asForeignUser = { getuid: () => 9999, getgroups: () => [process.getgid()] };
    assert.equal(
      withFakeUser(asForeignUser, () =>
        store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: join(parent, "accounts") }).ok,
      ),
      true,
      "group-writable must be accepted when the service is in the group",
    );
    // Und die Umkehrung: dieselbe Rechte, Dienst nicht in der Gruppe, muss
    // weiterhin abgelehnt werden.
    assert.equal(
      withFakeUser({ getuid: () => 9999, getgroups: () => [] }, () =>
        store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: join(parent, "accounts") }).ok,
      ),
      false,
      "group-writable must still be refused when the service is not in the group",
    );
  });
});

test("eine existierende, unbeschreibbare Wurzel nennt den Pfad statt des Elternverzeichnisses", () => {
  withHomeRoot((dir) => {
    const root = join(dir, "accounts");
    mkdirSync(root);
    chmodSync(root, 0o500);
    // Wir selbst sind der Besitzer, also greift der Besitzer-Zweig in
    // `isWritableDirectory` und meldet "beschreibbar" — korrekt, denn Besitzer
    // duerfen ein 0500-Verzeichnis betreten und anlegen. Fuer den Fall, um den
    // es hier geht, muss der Dienst ein *fremder* Benutzer sein: dann ist die
    // Meldung genau die, die ohne die neue Wurzel-Pruefung gar nicht entstuende.
    const foreign = withFakeUser({ getuid: () => 9999, getgroups: () => [] }, () =>
      store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: root }));
    assert.equal(foreign.ok, false);
    // Die Meldung muss von der Wurzel handeln: der Elternteil wird hier gar
    // nicht mehr angefasst.
    assert.match(foreign.detail, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(foreign.remediation, /OMP_WEB_HOME_ROOT|chown/);
  });
});

test("eine Kontoanlage unter /home nennt OMP_WEB_HOME_ROOT statt eines nackten EACCES", () => {
  withHomeRoot((dir) => {
    // `/home` ist auf dem Messhost `root:root 0755`. Der Pfad muss in der
    // Meldung stehen, damit der Admin weiss, welche Variable er setzt.
    const underHome = store.checkHomeRootWritable({ OMP_WEB_HOME_ROOT: "/home/probe-account" });
    if (process.getuid?.() === 0) return; // als root gibt es hier nichts zu beanstanden
    assert.equal(underHome.ok, false);
    assert.match(underHome.remediation, /OMP_WEB_HOME_ROOT/);

    assert.throws(
      () => store.createWebAccount("alice", PASSWORD, {
        env: { OMP_WEB_HOME_ROOT: "/home/probe-account" },
        file: join(dir, "auth.json"),
        accountsFile: join(dir, "accounts.json"),
        params: PARAMS,
      }),
      /OMP_WEB_HOME_ROOT/,
    );
  });
});

/**
 * Ein Konto muss sich auch dann anmelden koennen, wenn der Server gar kein
 * Passwort verlangt. Das ist der Normalfall, nicht die Ausnahme: der Admin hat
 * die Konten gerade ueber die Oberflaeche angelegt, und eine laufende
 * Installation hat selten ueberhaupt ein Passwort gesetzt.
 *
 * Ohne diesen Fall gae es kein `issueSessionCookie` zurueck — es gibt schlicht
 * keine Credentials, an die eine Sitzung gebunden werden koennte. Genau daran ist
 * dieser Test zuerst gescheitert.
 */
test("ein Konto meldet sich auch auf einem offenen Server an", async () => {
  const { verifyCredential } = await import("./web-auth.ts");
  const { issueSessionCookie, readSessionCookie } = await import("./web-auth-session.ts");

  await withAccounts(async (options) => {
    store.createWebAccount("alice", PASSWORD, options);
    assert.equal(store.resolveWebAuthPolicy(options).mode, "open");

    const identity = verifyCredential("alice", PASSWORD, options);
    assert.deepEqual(identity, { username: "alice", isAdmin: false });

    const cookie = issueSessionCookie({ ...options, username: identity.username });
    assert.equal(typeof cookie, "string");
    // The verifier takes the name from the cookie itself — that is the only
    // place a browser's request can say who it is. Passing a different name in
    // the options must therefore change nothing.
    assert.equal(readSessionCookie(cookie, options), "alice");
    assert.equal(readSessionCookie(cookie, { ...options, username: "omp" }), "alice");

    // What does not survive is a cookie whose signature belongs to someone
    // else, and a name that resolves to no account at all.
    const [version, issuedAt, expiry, nonce] = cookie.split(".");
    const asGhost = Buffer.from("gespenst", "utf8").toString("base64url");
    const bobCookie = issueSessionCookie({ ...options, username: identity.username });
    assert.equal(
      readSessionCookie(`${version}.${issuedAt}.${expiry}.${nonce}.${asGhost}.${bobCookie.split(".")[5]}`, options),
      null,
    );
  });
});
