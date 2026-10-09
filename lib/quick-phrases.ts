/**
 * Quick phrases: short, user-defined texts that the composer offers as one
 * click insert buttons above the input field.
 *
 * A phrase has two fields on purpose: the button shows `label`, the composer
 * inserts `text`. That is the only way a long or multi-line insertion can carry
 * a short button caption. An empty `label` is therefore legal and degrades to
 * the text itself — a blank button would be a silent malfunction. An empty
 * `text` is not: a phrase that inserts nothing has no purpose and is dropped.
 *
 * The list lives on the server, one file per account
 * (`lib/quick-phrases-store.ts`), and this module is what both sides agree on:
 * the shape, the validation, the defaults and the caption. It deliberately has
 * no `fs` and no `fetch`, so the browser bundle and the route can share it.
 *
 * It must not go through `/api/settings` — that endpoint projects a schema owned
 * by a pinned package, and these phrases are not part of it. The agent never
 * reads them either; they are composer input.
 *
 * The `localStorage` access at the bottom of this file exists only to migrate
 * the lists of the version that kept them in the browser. It is read once, at
 * the first server fetch, and cleared afterwards.
 */

/** Legacy key of the browser-only version. Read once, then removed. */
const LEGACY_STORAGE_KEY = "omp-quick-phrases";

/**
 * Zweiter Legacy-Schluessel, der nur ein Merkmal speichert: "der Nutzer hat
 * diese Liste schon gesehen oder angefasst". Er stand bewusst neben der Liste
 * und nicht darin — ein Nutzer, der alle Phrasen loescht, schreibt `[]`, und
 * dieses `[]` ist eine Entscheidung. Ein Fallback im Code ("leer? dann
 * Defaults") wuerde diese Entscheidung bei jedem Reload zuruecknehmen.
 *
 * Seine Aufgabe hat jetzt die Datei uebernommen: existiert sie, wird nie wieder
 * gesaet. Der Schluessel wird nur noch gelesen, um die alte Entscheidung
 * ("gesehen, leer ist gewollt") von der neuen ("nie eingerichtet") zu
 * unterscheiden, und dann geloescht.
 */
const LEGACY_SEEN_KEY = "omp-quick-phrases-seeded";

/**
 * Der Spiegel des zuletzt erfolgreich geladenen Standes.
 *
 * Zweck ist genau ein Fall: der Server ist nicht erreichbar und die Seite wird
 * neu geladen. Ohne diesen Schluessel waere die Oberflaeche dann leer und der
 * Nutzer wuerde seine Phrasen fuer verloren halten, obwohl sie auf der Platte
 * liegen — beim ersten Reload nach einer Stoerung genau der Moment, in dem man
 * sie braucht.
 *
 * Er ist ausdruecklich *keine* zweite Quelle der Wahrheit: er wird nur gelesen,
 * wenn der Abruf scheitert, und nie, um zu entscheiden, ob gesaet wird. Die
 * Datei gewinnt immer, sobald sie antwortet, und dieser Schluessel wird dann
 * mit dem neuen Stand ueberschrieben. Deshalb heisst sein Name auch `mirror`
 * und nicht `cache`: es ist eine Kopie zum Aufrechterhalten der Anzeige.
 */
const MIRROR_KEY = "omp-quick-phrases-mirror";

/** Laenge, auf die der Knopftext gekuerzt wird, wenn das Label leer ist. */
export const QUICK_PHRASE_LABEL_MAX = 40;

/**
 * Die Voreinstellungen, die ein neuer Nutzer sieht, ohne etwas einrichten zu
 * muessen. Reihenfolge = Reihenfolge der Knoepfe im Composer.
 *
 * Die ersten drei gehen nach aussen: sie recherchieren ein Thema, holen Fakten
 * und vergleichen Optionen, statt sich mit dem gerade sichtbaren Code zu
 * beschaeftigen. Ein leerer Eingabefeld ist bei ihnen kein Fehlfall, sondern der
 * Normalfall — es gibt dann nichts im Fenster, worueber man spricht. Die
 * uebrigen vier sind die klassischen Auftraege fuer den Code vor der Nase.
 *
 * Das sind die haeufigsten Auftraege fuer einen Coding-Agent. Sie sind Inhalt,
 * kein UI-Text, und werden deshalb nicht uebersetzt — genau wie ein vom Nutzer
 * getippter Text nicht uebersetzt wird.
 */
export const DEFAULT_QUICK_PHRASES: QuickPhrase[] = [
  {
    label: "Research",
    text: "Research this topic thoroughly. Give me the current state, the main options, and what the tradeoffs are between them.",
  },
  {
    label: "Compare",
    text: "Compare the realistic options for this. Table them by cost, effort and risk, then recommend one and say why.",
  },
  {
    label: "Verify",
    text: "Verify these claims against primary sources. Say clearly which ones hold and which ones do not.",
  },
  {
    label: "Explain",
    text: "Explain how this code works, step by step. Point out the risky parts.",
  },
  {
    label: "Review",
    text: "Review this code for bugs, race conditions and security issues. Report only findings with file and line.",
  },
  {
    label: "Tests",
    text: "Write tests for this code. Cover the edge cases and the failure paths, not just the happy path.",
  },
  {
    label: "Fix",
    text: "Find and fix the bug in this code. Explain the root cause before you propose the fix.",
  },
];

export interface QuickPhrase {
  /** Beschriftung des Knopfes. Leer = `text` wird als Beschriftung verwendet. */
  label: string;
  /** Der Text, der an der Cursorposition eingefuegt wird. */
  text: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Eine Rohphrase ist nur dann eine Phrase, wenn `text` ein nicht-leerer String
 * ist. Alles andere (fehlender Eintrag, Zahl, Objekt, Array) faellt weg, damit
 * ein von Hand manipulierter oder aus einer aelteren Version stammender Wert
 * keinen Button ohne Funktion erzeugen kann.
 */
function toQuickPhrase(value: unknown): QuickPhrase | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { label?: unknown; text?: unknown };
  if (typeof candidate.text !== "string" || candidate.text.length === 0) return null;
  return {
    label: typeof candidate.label === "string" ? candidate.label : "",
    text: candidate.text,
  };
}

/**
 * Die eine Validierung fuer beide Seiten: Datei lesen, Datei schreiben, HTTP
 * annehmen. Was hier durchfaellt, kann weder einen Knopf ohne Funktion
 * erzeugen noch einen fremden Datentyp in die Datei schreiben.
 *
 * Kein Schema, kein Framework: die Liste ist zwei Felder tief, und eine
 * ausfuehrliche Beschreibung des Formats an zwei Stellen ist driftfaehiger
 * als diese sieben Zeilen.
 */
export function normalizeQuickPhrases(value: unknown): QuickPhrase[] {
  if (!Array.isArray(value)) return [];
  return value.map(toQuickPhrase).filter((phrase): phrase is QuickPhrase => phrase !== null);
}

/** Was die Migration vorfindet: eine Liste, oder `null` = nie eingerichtet. */
export interface LegacyQuickPhrases {
  /** Die Phrasen, die in die Datei wandern. */
  phrases: QuickPhrase[];
  /** `true`, wenn beide Legacy-Schluessel fehlen und gesaet werden darf. */
  needsSeed: boolean;
}

/**
 * Die Browser-Liste der alten Version lesen, ohne etwas zu schreiben.
 *
 * Genau die drei Faelle, an denen ein Seed schon einmal Daten zerstoert hat,
 * in einer Abfrage statt in einem Schreibvorgang:
 *
 * 1. Beide Schluessel fehlen: nie eingerichtet, `needsSeed: true`.
 * 2. Flag vorhanden, Liste fehlt: der Nutzer hat alles geloescht. `[]` ist
 *    gewollt, es wird nicht nachgefuellt.
 * 3. Flag fehlt, Liste vorhanden: eine Version, die das Flag noch nicht
 *    kannte. Die Liste wird uebernommen — Phrasen zu ueberschreiben, die der
 *    Nutzer selbst angelegt hat, ist der schlimmste Fehler, den ein Seed
 *    machen kann, weil er beim ersten Lesen passiert.
 *
 * Ein blockierter Speicher (privater Modus, `SecurityError`) liefert Fall 1:
 * lieber einmal saeen als den Nutzer ohne Knoepfe dasitzen zu lassen.
 */
export function readLegacyQuickPhrases(storage: StorageLike | null = getBrowserStorage()): LegacyQuickPhrases {
  const seed = (): LegacyQuickPhrases => ({ phrases: [...DEFAULT_QUICK_PHRASES], needsSeed: true });
  if (!storage) return seed();
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Kaputter Bestand: das ist eine Liste, die jemand angelegt hat, auch
        // wenn sie nicht lesbar ist. Uebernehmen, nicht ueberschreiben.
        return { phrases: [], needsSeed: false };
      }
      return { phrases: normalizeQuickPhrases(parsed), needsSeed: false };
    }
    // Die Liste fehlt. Nur mit gesetztem Flag ist das eine Entscheidung des
    // Nutzers; ohne Flag ist es ein Browser, der nie eingerichtet war.
    if (storage.getItem(LEGACY_SEEN_KEY) !== null) return { phrases: [], needsSeed: false };
  } catch {
    // Blockierter Speicher: wie beim Workspace-Memory lieber saeen als den
    // Nutzer ohne Knoepfe dasitzen zu lassen.
    return seed();
  }
  return seed();
}

/**
 * Den erfolgreich geladenen Stand in den Spiegel schreiben, damit ein Reload
 * bei ausgefallenem Server die Anzeige nicht verliert.
 *
 * `setItem` nur beim Wechsel des Inhalts: bei jedem Tastendruck denselben Wert
 * zu schreiben ist eine Schreiboperation ohne Wirkung. Bestaetigen muss nichts,
 * der Spiegel darf jederzeit unbrauchbar sein.
 */
export function writeQuickPhrasesMirror(
  phrases: QuickPhrase[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  const encoded = JSON.stringify(phrases);
  try {
    if (storage.getItem(MIRROR_KEY) === encoded) return;
    storage.setItem(MIRROR_KEY, encoded);
  } catch {
    // Ein blockierter oder voller Speicher ist genau der Fall, in dem es den
    // Spiegel nicht gibt. Die Oberflaeche bleibt trotzdem bedienbar.
  }
}

/**
 * Der gespiegelte Stand, oder `null`, wenn es keinen gibt oder er unlesbar ist.
 *
 * `null` heisst hier ausdruecklich "nichts anzuzeigen" und wird nicht zu den
 * Voreinstellungen: bei einem Serverausfall die Defaults zu zeigen hiesse, den
 * Nutzer glauben zu lassen, seine eigenen Phrasen seien weg — und wuerde bei
 * einem darauf folgenden Schreibvorgang tatsaechlich ueberschrieben.
 */
export function readQuickPhrasesMirror(
  storage: StorageLike | null = getBrowserStorage(),
): QuickPhrase[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MIRROR_KEY);
    if (raw === null) return null;
    return normalizeQuickPhrases(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Die Legacy-Schluessel entfernen, nachdem die Datei den Stand hat.
 *
 * Erst danach, nie davor: stuerzt der Server zwischen Lesen und Schreiben ab,
 * steht die Liste beim naechsten Versuch noch im Browser und wird erneut
 * angeboten, statt fuer immer verloren zu sein.
 */
export function clearLegacyQuickPhrases(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
    storage.removeItem(LEGACY_SEEN_KEY);
  } catch {
    // Nur Kosmetik: die Datei ist die Quelle, ein liegengebliebener Rest
    // schaedet nichts, solange die Datei existiert.
  }
}

/**
 * Beschriftung eines Knopfes: das Nutzer-Label, sonst der auf eine Zeile
 * gekuerzte Text. Der volle Text gehoert als `title` an den Knopf.
 */
export function quickPhraseCaption(phrase: QuickPhrase): string {
  const label = phrase.label.trim();
  if (label) return label;
  const text = phrase.text;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUICK_PHRASE_LABEL_MAX ? `${flat.slice(0, QUICK_PHRASE_LABEL_MAX)}…` : flat;
}