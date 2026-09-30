"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./FileBrowserDialog.module.css";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { encodeFilePathForApi, getFileDirectory, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";

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
}

interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

interface ListRow {
  entry: DirectoryEntry;
  /** Laufende Nummer des Ordners, null fuer Dateien. */
  directoryIndex: number | null;
}

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
 * ein Verstecken wuerde wie ein Auswahlfehler wirken.
 */
export function FileBrowserDialog({
  open,
  title,
  initialPath,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: FileBrowserDialogProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState(() => trimTrailingSlash(initialPath));
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const titleId = useId();

  // Ordner sind die einzigen navigierbaren Zeilen. Der Index wird hier einmal
  // berechnet, damit Tastaturnavigation und Hervorhebung dieselbe Nummer
  // benutzen und die Liste nicht pro Zeile neu durchsucht werden muss.
  const { rows, directoryCount } = useMemo((): { rows: ListRow[]; directoryCount: number } => {
    let count = 0;
    const mapped: ListRow[] = entries.map((entry) => (
      entry.isDir ? { entry, directoryIndex: count++ } : { entry, directoryIndex: null }
    ));
    return { rows: mapped, directoryCount: count };
  }, [entries]);

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
    if (!open || activeIndex < 0) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const parentPath = currentPath === "/" ? null : getFileDirectory(currentPath);
  const canGoUp = parentPath !== null && parentPath !== "" && parentPath !== currentPath;
  // Ein nicht geladenes Verzeichnis ist kein bestaetigbares Ziel: die
  // Meldung darf nur ausgeblendet, nicht weggedrueckt werden.
  const visibleError = loadError !== null && loadError !== dismissedError ? loadError : null;
  const canConfirm = !loading && !busy && loadError === null;

  const enterDirectory = (index: number) => {
    if (index < 0 || index >= directoryCount) return;
    const row = rows.find((candidate) => candidate.directoryIndex === index);
    if (row) navigateTo(joinFilePath(currentPath, row.entry.name));
  };

  const moveActive = (direction: 1 | -1) => {
    if (directoryCount === 0) return;
    setActiveIndex((previous) => (previous + direction + directoryCount) % directoryCount);
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

  return (
    <div
      className={`omp-modal-backdrop ${styles.backdrop}`}
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

        <div ref={listRef} className={styles.list} role="listbox" aria-label={t("fileBrowser.currentFolder")}>
          {loading ? (
            <div className={styles.state}>{t("fileBrowser.loading")}</div>
          ) : rows.length === 0 ? (
            <div className={styles.state}>{t("fileBrowser.emptyFolder")}</div>
          ) : (
            rows.map(({ entry, directoryIndex }) => {
              if (directoryIndex === null) {
                return (
                  <div key={entry.name} className={`${styles.entry} ${styles.fileRow}`} aria-disabled="true">
                    {getFileIcon(entry.name, 13)}
                    <span className={styles.entryName}>{entry.name}</span>
                  </div>
                );
              }
              return (
                <button
                  key={entry.name}
                  type="button"
                  className={`omp-press ${styles.entry}`}
                  data-active={directoryIndex === activeIndex}
                  onClick={() => navigateTo(joinFilePath(currentPath, entry.name))}
                  onMouseEnter={() => setActiveIndex(directoryIndex)}
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
