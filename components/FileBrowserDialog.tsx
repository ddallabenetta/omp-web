"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./FileBrowserDialog.module.css";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { encodeFilePathForApi, getFileDirectory, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { isImagePath } from "@/lib/file-types";
import { useI18n } from "@/hooks/useI18n";

export type FileBrowserView = "list" | "grid";
export type FileBrowserSortDirection = "asc" | "desc";

export interface FileBrowserDialogProps {
  /** true rendert Backdrop und Panel, false rendert gar nichts. */
  open: boolean;
  /** Kopfzeilentext, z.B. "Copy to…". */
  title: string;
  /** Absoluter Startpfad; ein Wechsel setzt den internen Zustand zurueck. */
  initialPath: string;
  /** Beschriftung des Bestaetigungs-Buttons, z.B. "Copy here". */
  confirmLabel: string;
  /** Sperrt waehrend eines laufenden Schreibvorgangs Abbrechen und Bestaetigen. */
  busy?: boolean;
  onCancel: () => void;
  /** Bekommt den absoluten Pfad des aktuell angezeigten Ordners. */
  onConfirm: (destinationDir: string) => void;
  /**
   * Ansichtsmodus. Ohne diese Prop gewaehlt der Dialog selbst: Raster, wenn
   * `allowFiles` gesetzt ist, sonst Liste. Mit `Prop` ist der Zustand kontrolliert
   * und die Umschalt-Leiste wird nur dann gezeigt, wenn zusaetzlich
   * `onViewChange` uebergeben ist.
   */
  view?: FileBrowserView;
  /** Wird beim Umschalten der Ansicht aufgerufen. Ohne diese Prop erscheint keine Umschalt-Leiste. */
  onViewChange?: (view: FileBrowserView) => void;
  /**
   * Macht Dateien auswaehlbar. Ohne diese Prop bleiben Dateien bewusst
   * nicht-interaktive, ausgegraute Zeilen — nur Ordner koennen Ziel eines Copy
   * oder Move sein.
   */
  allowFiles?: boolean;
  /** Bekommt den absoluten Pfad einer angeklickten Datei; nur mit `allowFiles`. */
  onSelectFile?: (filePath: string) => void;
  /** Absoluter Pfad der gerade ausgewaehlten Datei; nur mit `allowFiles`. */
  selectedFile?: string | null;
}

interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

interface ListRow {
  entry: DirectoryEntry;
  /**
   * Laufende Nummer in der navigierbaren Reihenfolge, null fuer nicht
   * navigierbare Zeilen (Dateien ohne `allowFiles`).
   */
  navigableIndex: number | null;
}

/** Kachelmasse im Rastermodus. Ein CSS-Custom-Property haelt CSS und Rechnung synchron. */
const GRID_TILE_MIN_WIDTH = 108;
const GRID_TILE_HEIGHT = 118;
const GRID_GAP = 6;
/** Zusaetzlich gerenderte Reihen ueber und unter dem Sichtfenster. */
const GRID_OVERSCAN_ROWS = 2;
/** Reihen, die auch ohne gemessene Buehnenhoehe gerendert werden. */
const GRID_MIN_RENDER_ROWS = 8;
/** Vorabladen der Thumbnails, bevor die Kachel wirklich sichtbar wird. */
const THUMBNAIL_ROOT_MARGIN = "240px";

/** Sortierung laeuft ueber `localeCompare`; ein Collator pro Sortiervorgang waere bei 5000 Eintraegen messbar. */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Verzeichnislisting fuer die Zielordner-Auswahl. Dieselbe Route wie der
 * Explorer, damit die Auswahl dieselben Pfadgrenzen sieht und ein 403 der
 * Schreib-API nicht erst nach dem Bestaetigen auffaellt.
 */
async function fetchDirectory(dirPath: string): Promise<DirectoryEntry[]> {
  const response = await fetch(`/api/files/${encodeFilePathForApi(dirPath)}?type=list`);
  if (!response.ok) {
    let message = `Failed to load files (HTTP ${response.status})`;
    try {
      const data = await response.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Kein JSON-Body (z.B. HTML-Fehlerseite) — der HTTP-Status reicht.
    }
    throw new Error(message);
  }
  const data = await response.json() as { entries?: DirectoryEntry[] };
  return data.entries ?? [];
}

/** Trailing Slashes entfernen, damit "/" der einzige Pfad ohne Slash bleibt. */
function trimTrailingSlash(path: string): string {
  const normalized = normalizeFilePathSlashes(path).replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

/**
 * Brotkrume-Segmente eines absoluten Pfads mit kumuliertem Voller Pfad.
 * Der erste Segment behaelt den fuehrenden Slash, jeder weitere haengt sich mit
 * "/" an — sonst zeigte der Breadcrumb auf "/u" statt auf "/home/u".
 */
function pathCrumbs(path: string): Array<{ name: string; fullPath: string }> {
  const absolute = path.startsWith("/");
  const crumbs: Array<{ name: string; fullPath: string }> = [];
  let running = "";
  for (const part of path.split("/").filter(Boolean)) {
    running = running === "" && absolute ? `/${part}` : `${running}/${part}`;
    crumbs.push({ name: part, fullPath: running });
  }
  return crumbs;
}

/**
 * Reihenfolge der Eintraege: Verzeichnisse bleiben immer oben, innerhalb der
 * Gruppen entscheidet die Sortierrichtung. Das ist Nautilus-Verhalten und
 * zugleich die Grundlage fuer die laufende Nummer der navigierbaren Zeilen.
 */
function sortEntries(entries: DirectoryEntry[], direction: FileBrowserSortDirection): DirectoryEntry[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return sign * NAME_COLLATOR.compare(a.name, b.name);
  });
}

/** Spaltenzahl des Rasters aus der gemessenen Containerbreite. */
function gridColumnCount(containerWidth: number): number {
  if (containerWidth <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth + GRID_GAP) / (GRID_TILE_MIN_WIDTH + GRID_GAP)));
}

/** Bild-URL fuer eine Kachel. `type=read` ist der Zweig, der Bildbytes liefert. */
function imageThumbnailUrl(directory: string, name: string): string {
  return `/api/files/${encodeFilePathForApi(joinFilePath(directory, name))}?type=read`;
}

/**
 * Bildkachel mit gestaffeltem Ladebeginn.
 *
 * `src` wird erst gesetzt, wenn die Kachel in die Naehe des Sichtfensters
 * scrolled — der Beobachter meldet sie, lange bevor sie sichtbar ist, damit das
 * Bild beim Scrollen schon da ist. Ohne `IntersectionObserver` (etwa im
 * Wegwerf-Harness) laden die Kacheln sofort: dann entscheidet allein der
 * Virtualisierer, wie viele es ueberhaupt sind.
 *
 * Ein Beobachter je Kachel ist hier vertretbar, weil die Virtualisierung die
 * Zahl der *montierten* Kacheln begrenzt — bei 5000 Dateien sind das die
 * wenigen Dutzend des Sichtfensters, nicht 5000.
 */
function LazyThumbnail({ src, alt, useObserver }: { src: string; alt: string; useObserver: boolean }) {
  const holderRef = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(!useObserver);

  useEffect(() => {
    if (!useObserver) return;
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      (observations) => {
        if (observations.some((observation) => observation.isIntersecting)) setInView(true);
      },
      { rootMargin: THUMBNAIL_ROOT_MARGIN },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, [useObserver]);

  return (
    <span ref={holderRef} className={styles.thumbnailHolder}>
      {inView && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.thumbnail} src={src} alt={alt} loading="lazy" decoding="async" draggable={false} />
      )}
    </span>
  );
}

interface GridTileProps {
  entry: DirectoryEntry;
  selected: boolean;
  active: boolean;
  fullPath: string;
  directory: string;
  selectable: boolean;
  onOpen: (path: string) => void;
  onSelect: (path: string) => void;
  /** false erzwingt sofortiges Laden, wenn kein `IntersectionObserver` existiert. */
  useObserver: boolean;
  left: number;
  top: number;
  width: number;
}

/** Eine Rasterkachel: Bildvorschau bei Bildern, Dateisymbol bei allem anderen. */
function GridTile({
  entry,
  selected,
  active,
  fullPath,
  directory,
  selectable,
  onOpen,
  onSelect,
  useObserver,
  left,
  top,
  width,
}: GridTileProps) {
  const isDirectory = entry.isDir;
  const thumb = !isDirectory && isImagePath(entry.name);
  const content = (
    <>
      <span className={styles.thumbnailBox}>
        {thumb
          ? <LazyThumbnail src={imageThumbnailUrl(directory, entry.name)} alt={entry.name} useObserver={useObserver} />
          : isDirectory ? <FolderIcon size={30} /> : getFileIcon(entry.name, 30)}
      </span>
      <span className={styles.tileName}>{entry.name}</span>
    </>
  );
  const position = { left, top, width };
  const className = [
    styles.tile,
    isDirectory ? styles.tileDirectory : styles.tileFile,
    selected ? styles.tileSelected : "",
    active ? styles.tileActive : "",
  ].filter(Boolean).join(" ");

  if (isDirectory) {
    return (
      <button
        type="button"
        className={`omp-press ${className}`}
        style={position}
        data-active={active}
       
        onClick={() => onOpen(fullPath)}
        title={entry.name}
      >
        {content}
      </button>
    );
  }

  if (!selectable) {
    // Ohne `allowFiles` bleibt die Datei - wie in der Liste - sichtbar, aber
    // nicht bedienbar; der Nutzer soll sehen, dass sie da ist.
    return (
      <div
        className={className}
        style={position}
        aria-disabled="true"
        title={entry.name}
       
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`omp-press ${className}`}
      style={position}
      data-active={active}
     
      onClick={() => onSelect(fullPath)}
      title={entry.name}
    >
      {content}
    </button>
  );
}

/**
 * Zentriertes Datei-Browser-Panel zur Auswahl eines Zielordners, etwa fuer
 * Copy/Move-Aktionen aus dem Explorer-Kontextmenue.
 *
 * Der Aufrufer setzt nur `open`, die Beschriftungen und die beiden Callbacks;
 * Navigation, Breadcrumb, Tastaturbedienung sowie Lade- und Fehlerzustaende
 * sind vollstaendig intern.
 *
 * Dateien werden sichtbar, aber nicht auswaehlbar gerendert: nur Ordner koennen
 * Ziel eines Copy oder Move sein, und eine sichtbare deaktivierte Zeile
 * erklaert dem Nutzer, warum der Ordner daneben funktioniert und sie nicht —
 * ein Verstecken wuerde wie ein Auswahlfehler wirken. Erst `allowFiles` macht
 * aus den Zeilen oder Kacheln echte Ziele.
 *
 * Sortierung und Ansichtsmodus sind lokaler Darstellungszustand. Der
 * Rastermodus ist fensterweise gerendert (siehe `visibleRange`): ohne das
 * haetten 5000 Dateien 5000 Kacheln im DOM und davon so viele Thumbnail-
 * Requests, wie Bilder darunter sind.
 */
export function FileBrowserDialog({
  open,
  title,
  initialPath,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
  view,
  onViewChange,
  allowFiles = false,
  onSelectFile,
  selectedFile = null,
}: FileBrowserDialogProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState(() => trimTrailingSlash(initialPath));
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<FileBrowserSortDirection>("asc");
  const [uncontrolledView, setUncontrolledView] = useState<FileBrowserView>(() => allowFiles ? "grid" : "list");
  const [gridScrollTop, setGridScrollTop] = useState(0);
  const [gridViewport, setGridViewport] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const titleId = useId();

  const activeView: FileBrowserView = view ?? uncontrolledView;

  // Ohne `IntersectionObserver` laden Thumbnails sofort; der Virtualisierer
  // begrenzt die Zahl der Kacheln dann allein.
  const useThumbnailObserver = typeof IntersectionObserver !== "undefined";

  // Ordner sind die einzigen navigierbaren Zeilen; mit `allowFiles` kommen die
  // Dateien dazu. Der Index wird hier einmal berechnet, damit
  // Tastaturnavigation und Hervorhebung dieselbe Nummer benutzen und die Liste
  // nicht pro Zeile neu durchsucht werden muss.
  const sortedEntries = useMemo(() => sortEntries(entries, sortDirection), [entries, sortDirection]);
  const { rows, navigableCount } = useMemo((): { rows: ListRow[]; navigableCount: number } => {
    let count = 0;
    const mapped: ListRow[] = sortedEntries.map((entry) => {
      const navigable = entry.isDir || allowFiles;
      return { entry, navigableIndex: navigable ? count++ : null };
    });
    return { rows: mapped, navigableCount: count };
  }, [allowFiles, sortedEntries]);

  const navigateTo = useCallback((path: string) => {
    const target = trimTrailingSlash(path);
    // Nur die neueste Anfrage darf den Zustand schreiben; schnellere Klicks
    // duerfen sich nicht gegenseitig die Antworten ueberschreiben.
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCurrentPath(target);
    setActiveIndex(-1);
    setLoadError(null);
    setDismissedError(null);
    setGridScrollTop(0);
    setLoading(true);
    void fetchDirectory(target)
      .then((next) => {
        if (requestIdRef.current !== requestId) return;
        setEntries(next);
      })
      .catch((cause: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setEntries([]);
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });
  }, []);

  const startPath = trimTrailingSlash(initialPath);

  // Beim Oeffnen und bei einem Wechsel von `initialPath` beginnt die Auswahl
  // wieder am angegebenen Ordner statt auf dem zuletzt besuchten.
  useEffect(() => {
    if (!open) return;
    navigateTo(startPath);
  }, [navigateTo, open, startPath]);

  // Escape schliesst das Panel, solange kein Schreibvorgang laeuft.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
  }, [open]);

  // Aktiven Listeneintrag mit im Sichtbereich halten, sonst ist der letzte
  // Ordner einer langen Liste nur mit der Maus erreichbar.
  useEffect(() => {
    if (!open || activeIndex < 0 || activeView !== "list") return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, activeView, open]);

  // Buehnengroesse des Rasters: ohne sie laesst sich das Sichtfenster nicht
  // berechnen. `ResizeObserver` fehlt in aelteren Umgebungen, dann genuegt die
  // Breite aus dem ersten Layout.
  useEffect(() => {
    if (!open || activeView !== "grid") return;
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const box = grid.getBoundingClientRect();
      setGridViewport({ width: box.width, height: box.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [activeView, open]);

  if (!open) return null;

  const parentPath = currentPath === "/" ? null : getFileDirectory(currentPath);
  const canGoUp = parentPath !== null && parentPath !== "" && parentPath !== currentPath;
  // Ein nicht geladenes Verzeichnis ist kein bestaetigbares Ziel: die
  // Meldung darf nur ausgeblendet, nicht weggedrueckt werden.
  const visibleError = loadError !== null && loadError !== dismissedError ? loadError : null;
  const canConfirm = !loading && !busy && loadError === null;

  const enterDirectory = (index: number) => {
    if (index < 0 || index >= navigableCount) return;
    const row = rows.find((candidate) => candidate.navigableIndex === index);
    if (!row) return;
    const fullPath = joinFilePath(currentPath, row.entry.name);
    if (row.entry.isDir) navigateTo(fullPath);
    else onSelectFile?.(fullPath);
  };

  const moveActive = (direction: 1 | -1) => {
    if (navigableCount === 0) return;
    setActiveIndex((previous) => (previous + direction + navigableCount) % navigableCount);
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      enterDirectory(activeIndex);
    } else if (event.key === "Backspace" || event.key === "ArrowLeft") {
      event.preventDefault();
      if (canGoUp && parentPath) navigateTo(parentPath);
    } else if (event.key === "Home") {
      event.preventDefault();
      navigateTo("/");
    }
  };

  const crumbs = pathCrumbs(currentPath);

  const toggleView = () => {
    if (!onViewChange) return;
    const next: FileBrowserView = activeView === "list" ? "grid" : "list";
    if (view === undefined) setUncontrolledView(next);
    onViewChange(next);
  };

  const columns = gridColumnCount(gridViewport?.width ?? 0);
  const tileWidth = gridViewport && gridViewport.width > 0
    ? (gridViewport.width - GRID_GAP * (columns - 1)) / columns
    : GRID_TILE_MIN_WIDTH;
  const rowCount = Math.ceil(rows.length / columns);
  // Ohne gemessene Buehnenhoehe (erstes Layout, nicht gerenderter Zustand)
  // wird ein Mindestfenster gerendert, damit das Raster nie leer erscheint.
  const visibleRowCount = Math.max(
    GRID_MIN_RENDER_ROWS,
    Math.ceil((gridViewport?.height ?? 0) / (GRID_TILE_HEIGHT + GRID_GAP)) + GRID_OVERSCAN_ROWS * 2,
  );
  const firstRow = Math.max(0, Math.floor(gridScrollTop / (GRID_TILE_HEIGHT + GRID_GAP)) - GRID_OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, firstRow + visibleRowCount);
  const firstIndex = firstRow * columns;
  const lastIndex = Math.min(rows.length, lastRow * columns);
  const visibleRows = rows.slice(firstIndex, lastIndex);
  const canvasHeight = rowCount === 0 ? 0 : rowCount * GRID_TILE_HEIGHT + (rowCount - 1) * GRID_GAP;
  const canvasStyle = {
    "--tile-width": `${tileWidth}px`,
    "--tile-height": `${GRID_TILE_HEIGHT}px`,
    "--grid-gap": `${GRID_GAP}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`omp-modal-backdrop ${styles.backdrop}`}
      data-nested-overlay
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className={`omp-modal-panel ${styles.panel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleListKeyDown}
      >
        <div className={styles.header}>
          <span id={titleId} className={styles.title}>{title}</span>
          <button
            type="button"
            className={`omp-press ${styles.iconButton}`}
            onClick={onCancel}
            disabled={busy}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
          >
            <svg className={styles.iconGlyph} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className={styles.crumbs}>
          {canGoUp && (
            <button
              type="button"
              className={`omp-press ${styles.crumb} ${styles.upButton}`}
              onClick={() => parentPath && navigateTo(parentPath)}
              title={t("fileBrowser.upOneLevel")}
              aria-label={t("fileBrowser.upOneLevel")}
            >
              <svg className={styles.iconGlyph} viewBox="0 0 24 24" aria-hidden="true">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
          )}
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <span key={crumb.fullPath} className={styles.crumbGroup}>
                {isLast ? (
                  <span className={`${styles.crumb} ${styles.crumbCurrent}`} title={crumb.fullPath}>
                    {crumb.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`omp-press ${styles.crumb}`}
                    onClick={() => navigateTo(crumb.fullPath)}
                    title={crumb.fullPath}
                  >
                    {crumb.name}
                  </button>
                )}
                {!isLast && <span className={styles.crumbSeparator}>/</span>}
              </span>
            );
          })}
        </div>

        <div className={styles.toolbar}>
          <button
            type="button"
            className={`omp-press ${styles.sortButton}`}
            onClick={() => setSortDirection((previous) => previous === "asc" ? "desc" : "asc")}
            title={t("fileBrowser.sortByName")}
           
            aria-label={t("fileBrowser.sortByName")}
          >
            {t("fileBrowser.name")}
            <svg
              className={styles.sortGlyph}
              data-direction={sortDirection}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {sortDirection === "asc" ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
            </svg>
          </button>
          {onViewChange && (
            <div className={styles.viewToggle} role="group" aria-label={t("fileBrowser.viewMode")}>
              <button
                type="button"
                className={`omp-press-tint ${styles.viewButton} ${activeView === "list" ? styles.viewButtonActive : ""}`}
                onClick={() => activeView !== "list" && toggleView()}
                disabled={activeView === "list"}
                title={t("fileBrowser.viewList")}
                aria-pressed={activeView === "list"}
               
              >
                <svg className={styles.iconGlyph} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                type="button"
                className={`omp-press-tint ${styles.viewButton} ${activeView === "grid" ? styles.viewButtonActive : ""}`}
                onClick={() => activeView !== "grid" && toggleView()}
                disabled={activeView === "grid"}
                title={t("fileBrowser.viewGrid")}
                aria-pressed={activeView === "grid"}
               
              >
                <svg className={styles.iconGlyph} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {activeView === "list" ? (
          <div ref={listRef} className={styles.list} role="listbox" aria-label={t("fileBrowser.currentFolder")}>
            {loading ? (
              <div className={styles.state}>{t("fileBrowser.loading")}</div>
            ) : rows.length === 0 ? (
              <div className={styles.state}>{t("fileBrowser.emptyFolder")}</div>
            ) : (
              rows.map(({ entry, navigableIndex }) => {
                if (navigableIndex === null) {
                  return (
                    <div key={entry.name} className={`${styles.entry} ${styles.fileRow}`} aria-disabled="true">
                      {getFileIcon(entry.name, 13)}
                      <span className={styles.entryName}>{entry.name}</span>
                    </div>
                  );
                }
                const fullPath = joinFilePath(currentPath, entry.name);
                if (!entry.isDir) {
                  return (
                    <button
                      key={entry.name}
                      type="button"
                      className={`omp-press ${styles.entry} ${styles.fileRow} ${selectedFile === fullPath ? styles.entrySelected : ""}`}
                      data-active={navigableIndex === activeIndex}
                      onClick={() => onSelectFile?.(fullPath)}
                      onMouseEnter={() => setActiveIndex(navigableIndex)}
                      title={entry.name}
                     
                    >
                      {getFileIcon(entry.name, 13)}
                      <span className={styles.entryName}>{entry.name}</span>
                    </button>
                  );
                }
                return (
                  <button
                    key={entry.name}
                    type="button"
                    className={`omp-press ${styles.entry}`}
                    data-active={navigableIndex === activeIndex}
                    onClick={() => navigateTo(fullPath)}
                    onMouseEnter={() => setActiveIndex(navigableIndex)}
                    title={entry.name}
                   
                  >
                    <FolderIcon size={13} />
                    <span className={styles.entryName}>{entry.name}</span>
                    <svg className={styles.entryArrow} viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          <div
            ref={gridRef}
            className={styles.grid}
            role="listbox"
            aria-label={t("fileBrowser.currentFolder")}
           
            onScroll={(event) => setGridScrollTop(event.currentTarget.scrollTop)}
          >
            {loading ? (
              <div className={styles.state}>{t("fileBrowser.loading")}</div>
            ) : rows.length === 0 ? (
              <div className={styles.state}>{t("fileBrowser.emptyFolder")}</div>
            ) : (
              <div
                className={styles.gridCanvas}
                style={{ ...canvasStyle, height: canvasHeight }}
               
              >
                {visibleRows.map(({ entry, navigableIndex }, offset) => {
                  const index = firstIndex + offset;
                  const fullPath = joinFilePath(currentPath, entry.name);
                  return (
                    <GridTile
                      key={entry.name}
                      entry={entry}
                      fullPath={fullPath}
                      directory={currentPath}
                      selectable={allowFiles}
                      selected={selectedFile === fullPath}
                      active={navigableIndex !== null && navigableIndex === activeIndex}
                      onOpen={navigateTo}
                      onSelect={(path) => onSelectFile?.(path)}
                      useObserver={useThumbnailObserver}
                      left={(index % columns) * (tileWidth + GRID_GAP)}
                      top={Math.floor(index / columns) * (GRID_TILE_HEIGHT + GRID_GAP)}
                      width={tileWidth}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {visibleError && (
          <div className={styles.errorRow} role="alert">
            <span className={styles.errorText}>{visibleError}</span>
            <button
              type="button"
              className={`omp-press ${styles.errorRetry}`}
              onClick={() => navigateTo(currentPath)}
              disabled={loading}
            >
              {t("i18n.refresh")}
            </button>
            <button
              type="button"
              className={`omp-press ${styles.errorRetry}`}
              onClick={() => setDismissedError(loadError)}
              title={t("fileBrowser.dismiss")}
              aria-label={t("fileBrowser.dismiss")}
            >
              {t("i18n.close")}
            </button>
          </div>
        )}

        <div className={styles.footer}>
          <span className={styles.currentPath} title={currentPath} aria-label={t("fileBrowser.selectedFolder")}>
            {currentPath}
          </span>
          <button
            type="button"
            className={`omp-press ${styles.button}`}
            onClick={onCancel}
            disabled={busy}
          >
            {t("i18n.cancel")}
          </button>
          <button
            type="button"
            className={`omp-press-tint ${styles.button} ${styles.primary}`}
            onClick={() => onConfirm(currentPath)}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
