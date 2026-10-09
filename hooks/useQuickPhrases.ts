"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_QUICK_PHRASES,
  clearLegacyQuickPhrases,
  normalizeQuickPhrases,
  readLegacyQuickPhrases,
  readQuickPhrasesMirror,
  writeQuickPhrasesMirror,
  type QuickPhrase,
} from "@/lib/quick-phrases";

/**
 * Modul-Store fuer die Quick Phrases, jetzt mit dem Server als Quelle.
 *
 * Warum ein Store und keine Prop-Kette: Settings-Dialog und Composer liegen in
 * zwei Teilbaeumen ohne gemeinsamen Elter im Chat-Fall (ChatWindow haelt den
 * Ref, AppShell haelt den Zustand). Ein Store haelt die Liste in beiden
 * Ansichten synchron, ohne dass ein Reload noetig ist.
 *
 * ### Laden
 *
 * Das Laden passiert genau einmal, unabhaengig davon, wie viele Abonnenten
 * kommen. `pending` ist das laufende Versprechen: ein zweiter Aufrufer, solange
 * es laeuft, bekommt dasselbe und stellt keinen zweiten Request. Ohne das
 * feuern Composer und Dialog, die im Chat-Fall gleichzeitig montiert sind, zwei
 * GETs — und im ungünstigsten Fall zwei Saeen.
 *
 * Der erste Snapshot ist leer, bis der Server geantwortet hat. Das ist Absicht
 * und kein Zwischenzustand, den man wegoptimieren sollte: der Composer rendert
 * die Knopfzeile nur bei `length > 0`, ein leerer Zwischenstand erzeugt also
 * keinen Knopf und keine Trennlinie, die dann wieder verschwinden.
 *
 * ### Fehler
 *
 * Ein fehlgeschlagener Abruf leert nichts und blockiert nichts. `error` wird
 * gesetzt, die zuletzt gesehene Liste bleibt stehen, und der naechste Abruf
 * versucht es erneut. Nach einem Reload gibt es im Speicher nichts mehr — dann
 * kommt der Stand aus dem Spiegel in `lib/quick-phrases.ts`, damit ein
 * Serverausfall die Oberflaeche nicht leerzeigt. `loaded` bleibt `false`, damit
 * ein spaeterer erfolgreicher Abruf den Zustand noch nachziehen kann, statt die
 * Oberflaeche dauerhaft im Ladezustand zu lassen.
 *
 * ### Schreiben
 *
 * `setQuickPhrases(next, persist)` trennt "die Oberflaeche sieht es" von
 * "der Server bekommt es". Beim Tippen wird ohne Persistenz gesetzt, damit
 * Composer und Dialog sofort folgen, und der Schreibvorgang wird gebuendelt.
 * Das Debounce steht bewusst im Aufrufer (`components/QuickPhrasesConfig.tsx`):
 * es entscheidet, *wann* geschrieben wird, nicht wohin.
 */

const EMPTY: QuickPhrase[] = [];

export interface QuickPhrasesStatus {
  /** Die Liste, die gerade gilt. Leer, solange der erste Abruf laeuft. */
  phrases: QuickPhrase[];
  /** `true`, wenn der Server einmal geantwortet hat. */
  loaded: boolean;
  /** Der letzte Fehlertext, oder `null`. */
  error: string | null;
}

const INITIAL: QuickPhrasesStatus = { phrases: EMPTY, loaded: false, error: null };

const listeners = new Set<() => void>();
let state: QuickPhrasesStatus = INITIAL;
let pending: Promise<void> | null = null;
// Zaehler der Schreibabsichten. Siehe `setQuickPhrases`.
let lastWrite = 0;
// Die Kette aller ausgehenden Schreibvorgaenge. Sie serialisiert die PUTs.
let writeChain: Promise<void> = Promise.resolve();

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): QuickPhrasesStatus {
  return state;
}

function getServerSnapshot(): QuickPhrasesStatus {
  // Ohne Fenster gibt es keinen Server und keine Migration; der erste
  // Client-Render befuellt den Zustand.
  return INITIAL;
}

/** Der PUT. Antwortet mit der Liste, die der Server tatsaechlich gespeichert hat. */
async function putQuickPhrases(phrases: QuickPhrase[]): Promise<QuickPhrase[]> {
  const response = await fetch("/api/quick-phrases", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrases }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("phrases" in body)) {
    throw new Error("unexpected response shape");
  }
  return normalizeQuickPhrases(body.phrases);
}

/**
 * Holt die Liste genau einmal. Ein laufender Abruf wird wiederverwendet, ein
 * abgeschlossener nicht: nach einem Fehler oder einem Neuladen soll der
 * naechste Aufrufer es wieder versuchen.
 */
export function loadQuickPhrases(): Promise<void> {
  if (pending !== null) return pending;
  pending = (async () => {
    try {
      const response = await fetch("/api/quick-phrases", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("phrases" in body) || !("exists" in body)) {
        throw new Error("unexpected response shape");
      }

      if (body.exists === true) {
        // Die Datei gewinnt. Auch leer, denn eine leere Liste ist eine
        // Entscheidung des Nutzers. Der Browser wird nicht mehr angefasst —
        // die Legacy-Schluessel werden nur noch entfernt.
        const phrases = normalizeQuickPhrases(body.phrases);
        clearLegacyQuickPhrases();
        writeQuickPhrasesMirror(phrases);
        setPhrases(phrases);
        return;
      }

      // Keine Datei: der Bestand aus dem Browser wandert rüber, sonst wird
      // einmal gesaet. Gesaet wird *nicht*, was der Browser schon hatte.
      const legacy = readLegacyQuickPhrases();
      const migrated = legacy.needsSeed ? [...DEFAULT_QUICK_PHRASES] : legacy.phrases;
      // Der Stand steht zuerst in der Oberflaeche; das Warten auf den PUT darf
      // die Migration nicht aufhalten.
      setPhrases(migrated);
      writeQuickPhrasesMirror(migrated);
      await putQuickPhrases(migrated);
      clearLegacyQuickPhrases();
    } catch (error) {
      // Der letzte gesehene Stand bleibt stehen. Nach einem Reload gibt es
      // keinen im Speicher — dann kommt er aus dem Spiegel, damit ein
      // Serverausfall die Oberflaeche nicht leert. Ohne Spiegel bleibt es
      // leer, und das ist ehrlicher als Phrasen zu erfinden, die nicht da sind.
      const fallback = state.phrases.length > 0 ? state.phrases : readQuickPhrasesMirror() ?? [];
      state = {
        phrases: fallback,
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      };
      emit();
    } finally {
      pending = null;
    }
  })();
  return pending;
}

function setPhrases(phrases: QuickPhrase[]): void {
  if (
    state.phrases.length === phrases.length
    && state.phrases.every((phrase, index) => phrase === phrases[index])
    && state.loaded
    && state.error === null
  ) {
    return;
  }
  state = { phrases, loaded: true, error: null };
  emit();
}

/**
 * Setzt die Liste und meldet sie an alle Abonnenten. `persist: false` laesst
 * den HTTP-Aufruf weg — fuer Eingaben, die im Takt getippt werden und bei denen
 * der Aufrufer den Schreibvorgang selbst buendelt.
 *
 * Ungueltige Eintraege (leerer `text`) fallen dabei weg; die Oberflaeche haelt
 * ihre Zeile trotzdem sichtbar, sie erzeugt nur keinen Knopf.
 *
 * Der Fehlerpfad laesst die Oberflaeche unangetastet: `state.phrases` wird nur
 * bei einem erfolgreichen PUT durch die validierte Liste ersetzt. Sonst wuerde
 * ein Server, der gerade nicht antwortet, die zuletzt gesehene Liste loeschen.
 */
export function setQuickPhrases(phrases: QuickPhrase[], persist = true): void {
  setPhrases(normalizeQuickPhrases(phrases));
  if (!persist) return;
  const id = ++lastWrite;
  // **Nacheinander, nicht nebeneinander.** Zwei gleichzeitige PUTs werden vom
  // Server in der Reihenfolge verarbeitet, in der sie *ankommen*, und die
  // Ankunftsdreiecke sind nicht die Absichtsreihenfolge. Ein frueh abgeschickter
  // PUT kann nach einem spaeteren landen und damit die Datei auf einen
  // Zwischenstand zuruecksetzen — gemessen: nach "Add phrase" (leere Zeile,
  // geschrieben als `[]`) und einem Fuellen stand am Ende wieder `[]` in der
  // Datei, weil der erste PUT als letzter ankam.
  //
  // Der Auftrag wartet deshalb, bis der vorige abgeschlossen ist. Damit steht
  // die Datei am Ende in der Reihenfolge der Absichten, und `lastWrite` sorgt
  // nur noch dafuer, dass eine aeltere *Antwort* den Zustand nicht zuruecksetzt.
  writeChain = writeChain.then(async () => {
    try {
      const saved = await putQuickPhrases(state.phrases);
      if (id !== lastWrite) return;
      // Der Spiegel folgt erst dem bestaetigten Serverstand, nicht der Absicht.
      // Sonst zeigt ein fehlgeschlagener PUT beim naechsten Reload eine Liste,
      // die es nie gab.
      writeQuickPhrasesMirror(saved);
      setPhrases(saved);
    } catch (error: unknown) {
      if (id !== lastWrite) return;
      state = { ...state, error: error instanceof Error ? error.message : String(error) };
      emit();
    }
  });
}

/**
 * Schreibt `phrases` sofort auf den Server. Das ist der Weg, den ein wartender
 * Debounce am Fensterende nimmt.
 *
 * Die Liste wird uebergeben und nicht aus dem Store gelesen. Grund: der Store
 * verwirft per `normalizeQuickPhrases` jede Zeile ohne Text — eine Zeile, die
 * der Nutzer gerade anlegt und noch nicht ausgefuellt hat, ist genau so eine.
 * Ein Flush aus dem Store wuerde sie stillschweigend aus der Datei entfernen
 * und den Server auf einen Stand zuruecksetzen, den es nie gab. Gemessen war
 * das als "Add phrase, fuellen, und die Datei steht wieder auf `[]`".
 */
export function flushQuickPhrases(phrases: QuickPhrase[] = state.phrases): void {
  setQuickPhrases(phrases);
}

/**
 * Der Zustand inklusive Lade- und Fehlerstatus. Der erste Abruf haengt an
 * diesem Hook, deshalb ist er der einzige Aufruf, den ein Abonnent braucht.
 */
export function useQuickPhrases(): QuickPhrasesStatus {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    void loadQuickPhrases();
  }, []);

  return snapshot;
}