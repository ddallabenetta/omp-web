"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushQuickPhrases, setQuickPhrases, useQuickPhrases } from "@/hooks/useQuickPhrases";
import { quickPhraseCaption, type QuickPhrase } from "@/lib/quick-phrases";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsConfig.module.css";

/**
 * Quick phrases: anlegen, bearbeiten, loeschen.
 *
 * Zwei Felder pro Phrase, weil der Knopf im Composer das Label zeigt und der
 * eingefuegte Text etwas voellig anderes sein kann (lang, mehrzeilig). Ein
 * leeres Label ist erlaubt und faellt auf den Text zurueck; ein leerer Text
 * nicht — eine Phrase ohne Inhalt einzufuegen waere eine Fehlfunktion, also
 * verwirft `setQuickPhrases` sie.
 *
 * Die Reihenfolge der Zeilen ist die Reihenfolge der Knoepfe im Composer. Sie
 * ergibt sich aus der Speicherreihenfolge; eine eigene Sortier-UI gibt es
 * bewusst nicht.
 *
 * ### Warum getippt wird und nicht gespeichert wird
 *
 * `rows` haelt die Liste fuer die Oberflaeche, der Store haelt die
 * persistierte, validierte Liste. Jede Aenderung geht sofort in den Store, aber
 * nicht sofort auf den Server: `apply(next, false)` setzt lokal, und ein Timer
 * schreibt gebuendelt. Ohne das waere ein Request pro Buchstabe — bei 20
 * Zeichen 20 PUTs fuer ein Wort, und der letzte davon gewinnt die Race.
 *
 * Der Timer laeuft an drei Stellen ab, und alle drei sind noetig, weil der
 * Nutzer an jeder davon den Dialog schliessen kann, ohne den Speicher zu
 * bemerken: nach `DEBOUNCE_MS` Ruhe, beim Verlassen des Feldes (`onBlur`, weil
 * der Dialog die Knoepfe im Tab-Fokus erreichbar macht) und beim Unmount
 * (Dialog schliessen, Chat wechseln, Route wechseln).
 *
 * Blur und Unmount schreiben nur, wenn ueberhaupt ein Timer offen ist. Ohne
 * diese Bedingung sendet jedes Ueber-den-Dialog-Klicken einen PUT, obwohl
 * sich nichts geaendert hat — gemessen waren es zwei Requests fuer eine
 * Aenderung, weil der Fokuswechsel zwischen Label- und Textfeld je einen
 * ausgeloest hat.
 *
 * Delete umgeht den Timer. Ein Klick auf Delete, der erst beim naechsten
 * Buchstaben oder beim Schliessen des Dialogs schreibt, sieht fuer den Nutzer
 * aus wie "geloescht, aber es kommt wieder" — und bei einem Dialog, der ohne
 * Unmount-Flush geschlossen wird, waere es genau das.
 *
 * Add geht *nicht* sofort auf den Server, obwohl es sofort in den Store geht.
 * Eine neue Zeile hat zwingend einen leeren Text, und ein leerer Text ist per
 * `normalizeQuickPhrases` keine Phrase: der sofortige PUT wuerde die neue Zeile
 * verwerfen und damit die Liste auf das zuruecksetzen, was ohne die Zeile
 * gerade gespeichert war. Sie mit dem Timer zu schreiben kostet nichts — sie
 * ist bis zum ersten Zeichen ohnehin nur eine Zeile im Dialog, kein Knopf.
 */
const DEBOUNCE_MS = 400;

/** Der Handle-Typ der Umgebung, benannt statt `ReturnType<typeof setTimeout>`. */
type DebounceHandle = ReturnType<typeof setTimeout>;

export function QuickPhrasesConfig() {
  const { t } = useI18n();
  const { phrases: stored, error } = useQuickPhrases();
  const [rows, setRows] = useState<QuickPhrase[]>([]);
  // Erst nach der ersten Befuellung gehoeren die Zeilen dem Benutzer. Ohne diese
  // Sperre wuerde eine spaetere Store-Aenderung die getippte Eingabe ueberschreiben.
  const hydrated = useRef(false);
  const timer = useRef<DebounceHandle | null>(null);
  // `rows` wird bewusst ueber eine Ref gelesen, nicht ueber eine
  // `useCallback`-Abhaengigkeit: der Timer laeuft nach 400 ms, zu einem Zeitpunkt,
  // zu dem die Schliessung mit einem aelteren `rows` ausgefuehrt werden kann.
  // Eine Ref sieht immer den aktuellen Stand.
  const rowsRef = useRef<QuickPhrase[]>(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setRows(stored);
  }, [stored]);

  // Beim Unmount wird ohne den Timer gesichert: er kann nicht mehr feuern, wenn
  // die Komponente weg ist, und was offen ist, geht jetzt raus.
  useEffect(() => () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
      flushQuickPhrases(rowsRef.current);
    }
  }, []);

  // Gibt es ueberhaupt etwas zu schreiben? Ohne diese Bedingung sendet jedes
  // `onBlur` und jedes Unmount einen PUT, auch wenn seit dem letzten
  // Schreibvorgang nichts getippt wurde — beim blossen Durchklicken durch den
  // Dialog waeren das Requests ohne Aenderung.
  const flushPending = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    flushQuickPhrases(rowsRef.current);
  }, []);

  const apply = useCallback((next: QuickPhrase[], persist: boolean) => {
    setRows(next);
    // Die Ref vor dem Setzen des Zustands: der Unmount-Cleanup und der Timer
    // lesen daraus, und beide duerfen nicht einen Stand sehen, der eine
    // Aenderung zuruecknimmt.
    rowsRef.current = next;
    setQuickPhrases(next, persist);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!persist) {
      timer.current = setTimeout(() => {
        timer.current = null;
        flushQuickPhrases(rowsRef.current);
      }, DEBOUNCE_MS);
    }
  }, []);

  // Aus `rows` gelesen und nicht per Updater: React ruft Updater in der
  // Entwicklung zweimal auf, und der Schreibvorgang gehoert nicht in eines.
  const edit = useCallback((index: number, patch: Partial<QuickPhrase>) => {
    apply(rows.map((phrase, i) => (i === index ? { ...phrase, ...patch } : phrase)), false);
  }, [apply, rows]);

  // Sofort, nicht gebuendelt: siehe Kommentar oben.
  const remove = useCallback((index: number) => {
    apply(rows.filter((_, i) => i !== index), true);
  }, [apply, rows]);

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("settings.quickPhrases")}</h2>
        <p className={styles.contentDescription}>{t("settings.quickPhrasesDescription")}</p>
      </header>

      <div className={styles.settingsBody}>
        {error !== null && (
          <div className={styles.error}>
            {t("settings.quickPhrasesSaveFailed", { error })}
          </div>
        )}
        {rows.length > 0 && (
          <div className={styles.phraseList}>
            {rows.map((phrase, index) => (
              <div key={index} className={styles.phraseRow}>
                <div className={styles.phraseFields}>
                  <label className={styles.phraseField}>
                    <span className={styles.phraseFieldLabel}>{t("settings.quickPhrasesLabel")}</span>
                    <input
                      className={styles.textInput}
                      value={phrase.label}
                      placeholder={quickPhraseCaption({ label: "", text: phrase.text })}
                      onChange={(event) => edit(index, { label: event.target.value })}
                      onBlur={flushPending}
                    />
                  </label>
                  <label className={styles.phraseFieldWide}>
                    <span className={styles.phraseFieldLabel}>{t("settings.quickPhrasesText")}</span>
                    <textarea
                      className={styles.phraseText}
                      value={phrase.text}
                      rows={2}
                      onChange={(event) => edit(index, { text: event.target.value })}
                      onBlur={flushPending}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className={styles.dangerButton}
                  title={t("settings.quickPhrasesDelete")}
                  aria-label={t("settings.quickPhrasesDelete")}
                  onClick={() => remove(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className={styles.addPhrase}
          onClick={() => apply([...rows, { label: "", text: "" }], false)}
        >
          {t("settings.quickPhrasesAdd")}
        </button>
      </div>
    </div>
  );
}