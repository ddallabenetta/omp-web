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
 * Stored in localStorage, like every other purely visual setting in this app
 * (see AGENTS.md). The agent never reads these, so they must not go through
 * /api/settings — that endpoint projects a schema owned by a pinned package.
 * Best-effort: reading and writing are wrapped so a blocked storage (private
 * mode, SecurityError, quota) degrades to "no phrases" instead of crashing.
 */

const STORAGE_KEY = "omp-quick-phrases";

/** Laenge, auf die der Knopftext gekuerzt wird, wenn das Label leer ist. */
export const QUICK_PHRASE_LABEL_MAX = 40;

export interface QuickPhrase {
  /** Beschriftung des Knopfes. Leer = `text` wird als Beschriftung verwendet. */
  label: string;
  /** Der Text, der an der Cursorposition eingefuegt wird. */
  text: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

/** Die gespeicherte Liste, validiert. Unlesbarer Inhalt ergibt eine leere Liste. */
export function loadQuickPhrases(storage: StorageLike | null = getBrowserStorage()): QuickPhrase[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toQuickPhrase).filter((phrase): phrase is QuickPhrase => phrase !== null);
  } catch {
    return [];
  }
}

/** Schreibt die Liste. Phrasen ohne `text` werden vor dem Speichern verworfen. */
export function saveQuickPhrases(
  phrases: QuickPhrase[],
  storage: StorageLike | null = getBrowserStorage(),
): QuickPhrase[] {
  const valid = phrases.map(toQuickPhrase).filter((phrase): phrase is QuickPhrase => phrase !== null);
  if (!storage) return valid;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(valid));
  } catch {
    // Speicher nicht verfuegbar oder voll — die Phrasen bleiben dann eben
    // nur fuer diese Sitzung erhalten, genau wie beim Workspace-Memory.
  }
  return valid;
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