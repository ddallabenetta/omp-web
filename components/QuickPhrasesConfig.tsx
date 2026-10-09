"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setQuickPhrases, useQuickPhrases } from "@/hooks/useQuickPhrases";
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
 * Jede Aenderung schreibt sofort in den Speicher. `rows` haelt die Liste fuer
 * die Oberflaeche, der Store haelt die persistierte, validierte Liste: eine
 * Zeile ohne Text bleibt sichtbar bearbeitbar, erzeugt aber keinen Knopf und
 * ueberlebt einen Reload nicht. Ein zusaetzlicher Save-Knopf waere nur ein
 * weiterer Zustand, den es beim Schliessen zu verwerfen gaebe.
 */
export function QuickPhrasesConfig() {
  const { t } = useI18n();
  const stored = useQuickPhrases();
  const [rows, setRows] = useState<QuickPhrase[]>([]);
  // Erst nach der ersten Befuellung gehoeren die Zeilen dem Benutzer. Ohne diese
  // Sperre wuerde eine spaetere Store-Aenderung die getippte Eingabe ueberschreiben.
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setRows(stored);
  }, [stored]);

  const apply = useCallback((next: QuickPhrase[]) => {
    setRows(next);
    setQuickPhrases(next);
  }, []);

  // Aus `rows` gelesen und nicht per Updater: React ruft Updater in der
  // Entwicklung zweimal auf, und der Schreibvorgang gehoert nicht in eines.
  const edit = useCallback((index: number, patch: Partial<QuickPhrase>) => {
    apply(rows.map((phrase, i) => (i === index ? { ...phrase, ...patch } : phrase)));
  }, [apply, rows]);

  const remove = useCallback((index: number) => {
    apply(rows.filter((_, i) => i !== index));
  }, [apply, rows]);

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("settings.quickPhrases")}</h2>
        <p className={styles.contentDescription}>{t("settings.quickPhrasesDescription")}</p>
      </header>

      <div className={styles.settingsBody}>
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
                    />
                  </label>
                  <label className={styles.phraseFieldWide}>
                    <span className={styles.phraseFieldLabel}>{t("settings.quickPhrasesText")}</span>
                    <textarea
                      className={styles.phraseText}
                      value={phrase.text}
                      rows={2}
                      onChange={(event) => edit(index, { text: event.target.value })}
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
          onClick={() => apply([...rows, { label: "", text: "" }])}
        >
          {t("settings.quickPhrasesAdd")}
        </button>
      </div>
    </div>
  );
}