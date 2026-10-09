"use client";

import { useSyncExternalStore } from "react";
import { loadQuickPhrases, saveQuickPhrases, type QuickPhrase } from "@/lib/quick-phrases";

/**
 * Modul-Store fuer die Quick Phrases.
 *
 * Warum ein Store und keine Prop-Kette: Settings-Dialog und Composer liegen
 * in zwei Teilbaeumen ohne gemeinsamen Elter im Chat-Fall (ChatWindow haelt den
 * Ref, AppShell haelt den Zustand). Ein Store haelt die Liste in beiden
 * Ansichten synchron, ohne dass ein Reload noetig ist.
 *
 * Der Snapshot ist ein Array, das nur beim Schreiben ersetzt wird — so ist die
 * Identitaet stabil und useSyncExternalStore loest nicht bei jedem Rendern aus.
 */

const EMPTY: QuickPhrase[] = [];

const listeners = new Set<() => void>();
let state: QuickPhrase[] | null = null;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): QuickPhrase[] {
  // Erst der erste Abonnent liest den Speicher; danach ist `state` die Quelle,
  // damit Schreibvorgaenge nicht von einem zweiten Lesen ueberschrieben werden.
  state ??= loadQuickPhrases();
  return state;
}

function getServerSnapshot(): QuickPhrase[] {
  // Ohne Fenster gibt es keinen Speicher; die Liste ist dann schlicht leer und
  // der erste Client-Render befuellt sie.
  return EMPTY;
}

/** Die aktuelle Phrasenliste. Alle Abonnenten rendern bei einer Aenderung neu. */
export function useQuickPhrases(): QuickPhrase[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Schreibt die Liste in den Browser-Speicher und meldet sie an alle
 * Abonnenten. Ungueltige Eintraege (leerer `text`) fallen dabei weg.
 */
export function setQuickPhrases(phrases: QuickPhrase[]): void {
  const next = saveQuickPhrases(phrases);
  if (state && state.length === next.length && state.every((p, i) => p === next[i])) return;
  state = next;
  emit();
}