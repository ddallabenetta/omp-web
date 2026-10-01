"use client";

import { useEffect, useRef, useState } from "react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

export interface FileTab {
  kind: "file";
  id: string;
  label: string;
  /**
   * Leer, solange der Tab keine Datei hat — dann ist er ein von Hand
   * angelegter Platzhalter und traegt `label` als eigene Beschriftung. Nur das
   * grosse Explorer-Fenster legt solche Tabs an; die Leiste im rechten Panel
   * kennt sie nicht. Solange `filePath` leer ist, darf kein `FileViewer`
   * gerendert werden: er wuerde einen leeren Pfad laden und mit einer
   * Fehlermeldung enden.
   */
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff" | "edit";
  /**
   * Verzeichnis, in dem der Tab angelegt wurde. Nur gesetzt bei einem Tab
   * ohne Datei, und nur damit dessen Auswahl-Ansicht dort startet, wo der
   * Nutzer den Baum gerade stehen hat. Beim Zuweisen einer Datei ist der Wert
   * bedeutungslos und bleibt einfach stehen.
   */
  startPath?: string;
}

export interface TerminalTab {
  kind: "terminal";
  id: string;
  label: string;
  terminalId: string;
}

export type Tab = FileTab | TerminalTab;

/**
 * Mindestbewegung in Pixeln, ab der aus einem Klick ein Zug wird. Ohne diese
 * Schwelle waehlt schon das kleinste Wackeln beim Klick den Tab aus; mit ihr
 * muss der Zeiger vier Pixel wirklich gewandert sein, damit ausgewertet wird.
 * Der Wert liegt ueber dem, was ein ruhiger Klick an Rauschen erzeugt, und
 * unter der Flink-Grenze, ab der der Browser selbst schon eine Auswahl zieht.
 */
const DRAG_THRESHOLD_PX = 4;

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /**
   * Opt-in. Wenn gesetzt, lassen sich die Tabs mit Maus und Finger
   * verschieben, und beim Fallen wird `onReorder(id, beforeId)` gerufen.
   * `beforeId` ist die Id des Tabs, vor dem der gezogene Tab landet; ein
   * leerer String bedeutet "ganz ans Ende".
   *
   * Ohne diese Prop bleibt die Leibe unveraendert: keine Pointer-Handler,
   * kein `touch-action`, kein Verschieben. Das Fenster im Explorer schaltet
   * es ein, die Leiste im rechten Panel nicht — dort ist die Reihenfolge die
   * Reihenfolge, in der der Nutzer die Dateien geoeffnet hat.
   */
  onReorder?: (id: string, beforeId: string) => void;
}

/** Zustand eines laufenden Zugs, in einem Ref statt im State. */
interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  /** `false`, solange die Mindestbewegung nicht erreicht ist. */
  active: boolean;
  /** Waehrend des Zugs wandernd; beim Fallen der Index, an dem landen. */
  toIndex: number;
}

/** Was der Renderer zum Verschieben braucht. */
interface DragVisual {
  id: string;
  offsetX: number;
  fromIndex: number;
  toIndex: number;
  width: number;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onReorder }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragVisual | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Nach einem abgeschlossenen Zug darf der abschliessende Klick den Tab nicht
  // waehlen: die Auswahl ist genau das, was der Nutzer mit dem Zug vermieden
  // hat. Zurueckgesetzt wird bei jedem neuen `pointerdown`, damit das Flag
  // niemals in den naechsten Klick hineinragt.
  const swallowClickRef = useRef(false);
  // Dynamische Schluessel, im Lauf geaendert — deshalb eine Map und kein
  // Record. Sie haelt die Elemente fuer die Trefferpruefung beim Ziehen.
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  /**
   * Haelt den aktiven Tab sichtbar.
   *
   * Die Tabs waechsen nach rechts, und nichts hat sie bisher gerollt: im
   * Hauptpanel faellt das nicht auf, weil die Leiste dort breiter ist als die
   * Tabs. Im Explorer-Fenster ist sie es nicht — bei 415px Viewport sind 342px
   * Leiste gegen 360px Tabs, der neu geoeffnete Tab ragt 40px hinaus und sieht
   * abgeschnitten aus, obwohl die Kachel intakt ist. Die Leiste scrollt bereits
   * (`overflowX: auto` an der Wurzel, Zeile 184), es fehlte nur der Anlass.
   *
   * `nearest` statt `center`: es rollt nur so weit, wie noetig ist. Ein
   * `center` wuerde beim Wechsel zwischen zwei sichtbaren Tabs die halbe
   * Leiste mitschieben, obwohl nichts verdeckt war.
   *
   * Die Kachel traegt `scroll-margin`, damit sie nicht direkt am Rand klebt.
   */
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const active = tabRefs.current.get(activeTabId);
    if (!strip || !active) return;
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    if (!onReorder) return;
    // Nur die linke Taste zieht. Die mittlere schliesst den Tab
    // (`onAuxClick`); liefe sie mit, wuerde jeder Zug den Tab schliessen.
    if (event.button !== 0) return;
    // Der Schliessen-Knopf ist kein Griff zum Verschieben.
    if ((event.target as HTMLElement).closest("button")) return;
    swallowClickRef.current = false;
    dragRef.current = {
      id: tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      active: false,
      toIndex: tabs.findIndex((tab) => tab.id === tabId),
    };
    // Pointer-Capture haelt die Bewegung am Tab, auch wenn der Zeiger ueber
    // den Rand der Leiste wandert. Ohne die API laeuft das Ziehen trotzdem,
    // nur ohne Ueberlauf-Fortsetzung.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId || state.id !== tabId) return;
    const delta = event.clientX - state.startX;
    if (!state.active) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      state.active = true;
      swallowClickRef.current = true;
    }

    const fromIndex = tabs.findIndex((tab) => tab.id === state.id);
    const element = tabRefs.current.get(state.id);
    if (fromIndex < 0 || !element) return;
    const rect = element.getBoundingClientRect();
    // Die Mitte des gezogenen Tabs entscheidet, wo es landet. Verglichen
    // wird gegen die Mitte jedes Tabs, das der Zeiger kreuzt — in beide
    // Richtungen, damit der Tab auch ueber den Rand der Liste wandern kann.
    const center = rect.left + rect.width / 2 + delta;
    let toIndex = fromIndex;
    tabs.forEach((tab, index) => {
      if (index === fromIndex) return;
      const other = tabRefs.current.get(tab.id);
      if (!other) return;
      const otherMiddle = other.getBoundingClientRect().left + other.getBoundingClientRect().width / 2;
      if (index < fromIndex && center < otherMiddle) toIndex = Math.min(toIndex, index);
      if (index > fromIndex && center > otherMiddle) toIndex = Math.max(toIndex, index);
    });
    state.toIndex = toIndex;

    setDrag({ id: state.id, offsetX: delta, fromIndex, toIndex, width: rect.width });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.releasePointerCapture === "function"
      && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const state = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!state || !state.active) return;

    // Der eigentliche Umbau: nicht die Position rueckgaengig machen, sondern
    // die Reihenfolge melden. Wer nur den Versatz zuruecksetzt, laesst den Tab
    // beim naechsten Aufbau wieder an seiner alten Stelle stehen — er waere
    // nur optisch gewandert, nicht wirklich umsortiert.
    const without = tabs.filter((tab) => tab.id !== state.id);
    // `toIndex` ist der Zielplatz in der Liste *nach* dem Herausnehmen, und
    // genau dort wird wieder eingefuegt — nach links wie nach rechts gleich.
    const before = without[state.toIndex];
    onReorder?.(state.id, before?.id ?? "");
  };

  return (
    <div
      ref={stripRef}
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        // Nur der gezogene Tab folgt dem Zeiger; die uebrigen ruecken in die
        // Luecke, die beim Fallen ohnehin entsteht, damit man sie vorher sieht.
        let shift = 0;
        if (drag && index !== drag.fromIndex) {
          if (drag.fromIndex < drag.toIndex && index > drag.fromIndex && index <= drag.toIndex) shift = -drag.width;
          else if (drag.toIndex < drag.fromIndex && index >= drag.toIndex && index < drag.fromIndex) shift = drag.width;
        }
        const dragging = drag?.id === tab.id;
        return (
          <div
            key={tab.id}
            ref={(element) => {
              if (element) tabRefs.current.set(tab.id, element);
              else tabRefs.current.delete(tab.id);
            }}
            onClick={() => {
              if (swallowClickRef.current) {
                swallowClickRef.current = false;
                return;
              }
              onSelectTab(tab.id);
            }}
            onPointerDown={(event) => handlePointerDown(event, tab.id)}
            onPointerMove={(event) => handlePointerMove(event, tab.id)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              // Haelt den Kachelrand vom Leistenrand weg, wenn der aktive
              // Tab hineingescrollt wird. Ohne das klebt er exakt am Rand und
              // wirkt angeschnitten, was genau der Eindruck ist, den wir hier
              // vermeiden.
              scrollMarginInline: 4,
              flexShrink: 0,
              userSelect: "none",
              // `touch-action: none` nur auf dem Tab, und nur wenn Verschieben
              // erlaubt ist. Auf der Leiste waere es falsch: dann kaeme man auf
              // dem Telefon gar nicht mehr waagerecht durch die Tabs wischen.
              touchAction: onReorder ? "none" : undefined,
              transform: dragging ? `translateX(${drag!.offsetX}px)` : shift !== 0 ? `translateX(${shift}px)` : undefined,
              // Der gezogene Tab darf dem Zeiger nicht hinterherlaufen, die
              // zurueckweichenden Tabs duerfen es.
              transition: dragging ? undefined : "background 0.1s, color 0.1s, transform 0.12s ease-out",
              opacity: dragging ? 0.85 : 1,
            }}
          >
            {/* Ein Tab ohne Datei bekommt bewusst KEIN Datei-Icon. Der Pfad
                von `getFileIcon` waere der leere String, der ohne Treffer in
                `EXTENSION_ICONS` auf das generische Dateisymbol zurueckfaellt
                — und damit behauptete der Tab, eine Datei zu zeigen. Ein
                leerer Tab braucht ein Merkmal, das seinen Zustand nennt und
                nicht seinen Inhalt. */}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "file" && !tab.filePath ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              ) : (
                getFileIcon(tab.label, 13)
              )}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              // Ohne Datei waere `tab.filePath` leer und der Tooltip stumm —
              // sichtbar ist dann nur der Titel des Tabs. Die Beschriftung
              // steht als Rueckfall dahinter, weil sie auch fuer einen leeren
              // Tab das einzige ist, was ihn benennt.
              title={tab.kind === "file" ? (tab.filePath || tab.label) : `Terminal · ${tab.label}`}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
