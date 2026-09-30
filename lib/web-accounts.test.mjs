import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
