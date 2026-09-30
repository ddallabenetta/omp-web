"use client";

import { forwardRef, useState, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import windowStyles from "./FileExplorerWindow.module.css";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { isImagePath } from "@/lib/file-types";
import { FileActionToast, FileContextMenu, type FileActionNotice, type FileMenuTarget } from "./FileContextMenu";
import { FileBrowserDialog } from "./FileBrowserDialog";
import { FileImagePreview } from "./FileImagePreview";
import { FileViewer } from "./FileViewer";
import { TabBar, type FileTab } from "./TabBar";
import { useI18n } from "@/hooks/useI18n";
type Translate = ReturnType<typeof useI18n>["t"];

/**
 * Ein fuer die Toolbar ausgewaehlter Baumknoten. Der Pfad genuegt als Schluessel,
 * Name und Ordner-Flag werden beim Klick mitgefuehrt, damit die Werkzeuge ohne
 * Rueckgriff auf den Baum auskommen.
 */
interface SelectionEntry {
  path: string;
  name: string;
  isDir: boolean;
}

/**
 * Der Blick auf den Baum: welcher Ordner oben steht und welche Aeste offen sind.
 * Er wandert als Prop von einer Instanz zur anderen, damit das grosse Fenster
 * seine Position nicht bei jedem Oeffnen verliert — es wird beim Schliessen aus
 * dem DOM entfernt, sein Zustand also nicht vom React-State behalten.
 */
export interface ExplorerViewState {
  currentPath: string;
  expandedPaths: Set<string>;
}

/**
 * Zwei Blicke gelten als gleich, wenn Pfad und aufgeklappte Ordner
 * uebereinstimmen. Der Vergleich entscheidet darueber, ob eine Meldung den
 * Zustand der aeusseren Instanz ueberhaupt anfasst: gibt der Melder denselben
 * Inhalt zurueck, bleibt der Zustand gleich und React rendert nicht neu.
 * Ohne diese Pruefung wuerden Fenster und Meldung einander hochschaukeln.
 */
function sameViewState(a: ExplorerViewState, b: ExplorerViewState): boolean {
  if (a.currentPath !== b.currentPath) return false;
  if (a.expandedPaths.size !== b.expandedPaths.size) return false;
  for (const path of a.expandedPaths) if (!b.expandedPaths.has(path)) return false;
  return true;
}

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /**
   * Zusaetzlicher Refresh der Umgebung. Die eigene Toolbar laedt den Baum ohnehin
   * neu; darueber hinaus braucht der Refresh-Button aber auch die Aussenwelt
   * (Git-Stand im Datei-Tab) im Takt. Ohne den Callback bleibt es beim lokalen
   * Nachladen.
   */
  onRefresh?: () => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  /**
   * Startzustand des Baums fuer eine Instanz, die nach dem Schliessen wieder
   * gemountet wird. Setzt die aufrufende Instanz den Wert, beginnt der Baum bei
   * diesem Pfad mit genau diesen offenen Aesten; der geladene Baum selbst wird
   * trotzdem neu geholt.
   */
  initialViewState?: ExplorerViewState;
  /**
   * Meldet jede Aenderung an Pfad und offenen Aesten nach aussen. Zusammen mit
   * `initialViewState` laesst sich damit eine Instanz aus dem DOM nehmen und
   * spaeter mit demselben Blick wieder einsetzen.
   *
   * Es ist ein echter Zustandskanal und kein Benachrichtigungs-Flag: der Melder
   * entscheidet, was an den Zustand der aufrufenden Instanz weitergegeben wird.
   * Wegen `sameViewState` entsteht dabei kein Pingpong, und weil der Baum erst
   * nach dem Mount geladen wird, kann der Melder nie eine `currentPath` melden,
   * die die Lade-Anfrage nicht kennt.
   */
  onViewStateChange?: (view: ExplorerViewState) => void;
  /**
   * Unterdrueckt den Knopf, der den Explorer in ein eigenes Fenster oeffnet.
   * Die Instanz im Fenster setzt das: ein Explorer im Explorer, der sich selbst
   * oeffnen darf, waere ein Klick ohne Ende.
   */
  allowPopup?: boolean;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

/**
 * Rechte Kanten der absoluten Hover-Knöpfe einer Baumzeile, in Pixeln.
 *
 * Die Knöpfe stehen nebeneinander am rechten Zeilenrand. Von rechts nach links:
 * Download (4), grosse Vorschau (30), Mention (58 bei Dateien, 4 bei Ordnern).
 * Die beiden Bildwerkzeuge sind 22 Pixel breit (20 plus je ein Pixel Rahmen),
 * der Download-Anker 23 (5 Pixel Polster links und rechts um ein 11-Pixel-Zeichen
 * plus Rahmen). Zwischen den 22-Pixel-Knoepfen bleiben damit 4 Pixel Luft, und
 * die Kante des 23-Pixel-Ankers liegt genau an der linken Kante des
 * Bildknopfes.
 *
 * Die Mention-Schaltflaeche traegt Text und ist je nach Sprache unterschiedlich
 * breit; sie steht deshalb ganz links. Ihre Breite kann so wachsen, wie es die
 * Uebersetzung verlangt, ohne einen Nachbarn zu ueberdecken.
 */
const ROW_ACTION_RIGHT_DOWNLOAD = 4;
const ROW_ACTION_RIGHT_IMAGE = 30;
const ROW_ACTION_RIGHT_MENTION_FILE = 58;
const ROW_ACTION_RIGHT_MENTION_DIR = 4;

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

/**
 * Spreizendes Bild als Zeichen fuer die grosse Vorschau. Bewusst nicht das
 * Dateityp-Symbol der Zeile: es steht zusammen mit Mention und Download auf
 * der Zeile und muss als Werkzeug erkennbar sein, nicht als Inhalt.
 */
function ImageOpenIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
    className="omp-press"
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

/** Bytestaende mit 1024er-Stufen, sonst sind grosse Dateien unlesbar. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface FileMeta {
  size: number;
  mime: string;
  language: string;
}

/**
 * Eigenschaften eines Eintrags: Name, Ort, Groesse und Typ.
 *
 * `?type=meta` beantwortet nur Dateien und lehnt Ordner mit 400 ab, darum
 * fragt der Dialog fuer Ordner ueber `?type=list` und zeigt die Zahl der
 * enthaltenen Eintraege. Eine Aenderungszeit liefert keine der beiden Routen
 * (das Listing fuellt `modified` bewusst nicht, `meta` kennt kein mtime) —
 * sie wuerde hier erfunden, also bleibt die Zeile weg.
 */
function PropertiesDialog({ target, onClose, t }: { target: SelectionEntry; onClose: () => void; t: Translate }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    const query = target.isDir ? "list" : "meta";
    setMeta(null);
    setItemCount(null);
    setError(null);
    void fetch(`/api/files/${encodeFilePathForApi(target.path)}?type=${query}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as Partial<FileMeta> & { entries?: unknown[]; error?: string };
        if (cancelled) return;
        if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
        if (target.isDir) { setItemCount(data.entries?.length ?? 0); return; }
        setMeta({ size: data.size ?? 0, mime: data.mime ?? "", language: data.language ?? "" });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="omp-modal-backdrop"
      data-nested-overlay
      style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className="omp-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: 360,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 14,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          outline: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {target.isDir ? <FolderIcon size={18} /> : getFileIcon(target.name, 18)}
          </span>
          <span id={titleId} style={{ minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {target.name}
          </span>
        </div>

        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", margin: 0, fontSize: 11, minWidth: 0 }}>
          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesName")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{target.name}</dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesPath")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{target.path}</dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesSize")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
            {error
              ? "—"
              : meta
                ? formatFileSize(meta.size)
                : target.isDir
                  ? itemCount === null ? "…" : t("files.propertiesSizeFolder", { count: itemCount })
                  : "…"}
          </dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesType")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
            {target.isDir
              ? t("files.propertiesFolder")
              : error ? "—" : meta ? (meta.mime || "—") : "…"}
          </dd>

          {!target.isDir && !error && meta?.language && (
            <>
              <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesLanguage")}</dt>
              <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{meta.language}</dd>
            </>
          )}
        </dl>

        {error && (
          <div role="alert" style={{ fontSize: 11, color: "var(--danger)", overflowWrap: "anywhere" }}>
            {t("files.propertiesLoadFailed")}: {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="omp-press"
            onClick={onClose}
            style={{
              height: 24,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {t("files.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Der KOMPLETTE Explorer in einem grossen, zentrierten Fenster.
 *
 * Bewusst kein Bild-Popup und kein Dialog mit einer Bestaetigung: hier steht
 * der ganze Explorer — Baum, Breadcrumb, Toolbar, Aenderungsliste, Git-Status.
 * Die Bildvorschau rendert die Instanz darin selbst, weil sie deren
 * Preview-State besitzt; dieses Fenster gibt es dafuer nicht noch einmal.
 *
 * Sie bleibt bewusst eine eigene Komponente in dieser Datei. `PropertiesDialog`
 * oben steht aus demselben Grund hier, und beide bekommen die Daten ueber
 * Props statt ueber einen gemeinsamen Zustand.
 *
 * Eigener Dateizustand, nicht der des Hauptpanels. Ein Klick auf eine Datei
 * im Fenster oeffnet einen Tab *hier* und sonst nirgends: `handleOpenFile`
 * unten setzt genau diesen State und ruft nichts von aussen. Vorher lief
 * derselbe Aufruf durch wie in der Seitenleiste, landete also im rechten
 * Panel der Hauptseite — der Nutzer sah die Datei nie, waehrend er im
 * Explorer stand. Der Tab-Zustand gehoert diesem Fenster und wird mit ihm
 * aus dem DOM entfernt; beim naechsten Oeffnen ist er leer. Das ist gewollt:
 * es ist ein Arbeitswerkzeug fuer einen Durchgang, kein dauerhafter
 * Dateistapel. Wer das Fenster behalten will, laesst es offen.
 *
 * Die Fenster-Instanz bekommt kein `onAtMention`/`onAtMentions`. Eine Mention
 * aus einem Fenster heraus schreibt in den Chat, den der Nutzer gar nicht
 * ansieht; die Seitenleiste bleibt der Ort, von dem aus man den Chat fuellt.
 * Aus demselben Grund bekommen die Tabs hier auch kein `onMentionLines` und
 * kein `onAtMention` im `FileViewer`.
 */
function FileExplorerWindow({
  cwd,
  changesCollapsed,
  initialViewState,
  onViewStateChange,
  onClose,
  t,
}: {
  cwd: string;
  changesCollapsed: boolean;
  initialViewState?: ExplorerViewState;
  onViewStateChange: (view: ExplorerViewState) => void;
  onClose: () => void;
  t: Translate;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  /**
   * Der einzige Weg aus dem Explorer dieses Fensters in einen Tab. Gleiche
   * Tab-Id und gleiche Duplikatregel wie im Hauptpanel (`AppShell.tsx`): ein
   * zweiter Klick auf dieselbe Datei aktiviert den vorhandenen Tab, statt einen
   * zweiten anzulegen. `modeHint` wandert mit, damit ein Klick in der
   * Aenderungsliste weiterhin die Diff-Ansicht oeffnet.
   */
  const handleOpenFile = useCallback((filePath: string, fileName: string, options?: OpenFileOptions) => {
    const tabId = `file:${filePath}`;
    const modeHint = options?.modeHint;
    setTabs((prev) => {
      const existing = prev.find((tab) => tab.id === tabId);
      if (!existing) {
        return [...prev, { kind: "file", id: tabId, label: fileName, filePath, initialDisplayMode: modeHint }];
      }
      if (!modeHint || existing.initialDisplayMode === modeHint) return prev;
      return prev.map((tab) => (tab.id === tabId ? { ...tab, initialDisplayMode: modeHint } : tab));
    });
    setActiveTabId(tabId);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        // Wie im Hauptpanel: der letzte linke Nachbar wird aktiv. Mit dem
        // leeren Leerzustand waere sonst jeder Klick auf das X ein Sprung in
        // den Leer-Zustand.
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, []);

  const handleReorder = useCallback((tabId: string, beforeId: string) => {
    setTabs((prev) => {
      const from = prev.findIndex((tab) => tab.id === tabId);
      if (from < 0) return prev;
      const without = prev.filter((tab) => tab.id !== tabId);
      const to = beforeId ? without.findIndex((tab) => tab.id === beforeId) : without.length;
      if (to < 0) return prev;
      return [...without.slice(0, to), prev[from], ...without.slice(to)];
    });
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /**
       * In diesem Fenster liegen die Dialoge der inneren Explorer-Instanz:
       * Bildvorschau, Zielordner und Properties. Jeder von ihnen hat seinen
       * eigenen `document`-Listener, und `stopPropagation` wirkt zwischen
       * Geschwistern auf demselben Knoten nicht — ein Tastendruck wuerde sonst
       * alle Ebenen auf einmal schliessen. Deshalb entscheidet nicht die
       * Reihenfolge der Listener, sondern das DOM: ist der Tastendruck in
       * einer Ebene gelandet, die selbst noch etwas offen haelt, schliesst
       * dieses Fenster nicht.
       *
       * `preventDefault` genuegt als Signal, weil die Bildvorschau es fuer ihre
       * Zoomtasten setzt, aber nicht fuer Escape. Der Test auf einen tieferen
       * Dialog ist deshalb der verlaessliche: er fragt ab, ob zwischen dem
       * Tastendruck und diesem Fenster noch etwas liegt.
       */
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-nested-overlay]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className={`omp-modal-backdrop ${windowStyles.backdrop}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`omp-modal-panel ${windowStyles.panel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={windowStyles.header}>
          <span id={titleId} className={windowStyles.title} title={cwd}>
            {t("files.explorerWindowTitle")}: {cwd}
          </span>
          <button
            type="button"
            className={`omp-press ${windowStyles.iconButton}`}
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
          >
            <svg className={windowStyles.glyph} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Waagerechte Leiste direkt unter der Kopfzeile, darunter der Baum
            und daneben der Inhalt. Waagerecht, weil ein senkrechter Streifen
            dem Baum genau die Breite genommen haette, um die es hier geht. */}
        {tabs.length > 0 && (
          <div className={windowStyles.tabBar}>
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId ?? ""}
              onSelectTab={setActiveTabId}
              onCloseTab={handleCloseTab}
              onReorder={handleReorder}
            />
          </div>
        )}

        <div className={windowStyles.explorer}>
          <FileExplorer
            cwd={cwd}
            onOpenFile={handleOpenFile}
            initialViewState={initialViewState}
            onViewStateChange={onViewStateChange}
            changesCollapsed={changesCollapsed}
            allowPopup={false}
          />
        </div>

        {/* Derselbe `FileViewer` wie im rechten Panel der Hauptseite. Eine
            eigene Ansicht hier wuerde von der Panel-Fassung abdriften, und
            gerade der Diff- und der Markdown-Umschalter sind zu gross, um
            sie zu duplizieren. Kein `sourceSessionId`, weil der Explorer
            bereits auf `cwd` steht; ohne die Mention-Props, weil sie in den
            Chat der Hauptseite schreiben wuerden, den man hier nicht sieht. */}
        {activeTab ? (
          <div className={windowStyles.content}>
            <FileViewer
              filePath={activeTab.filePath}
              cwd={cwd}
              initialDisplayMode={activeTab.initialDisplayMode}
              onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath))}
            />
          </div>
        ) : (
          <div className={windowStyles.empty}>{t("files.explorerWindowNoTab")}</div>
        )}
      </div>
    </div>
  );
}

interface ExplorerToolbarProps {
  selection: SelectionEntry[];
  uploadBusy: boolean;
  onNewFolder: (name: string) => void;
  onRefresh: () => void;
  /** `true` heisst: der Refresh ist gerade durch, der Haken bestaetigt das. */
  refreshDone: boolean;
  onUpload: () => void;
  onCopyTo: () => void;
  onMoveTo: () => void;
  onClearSelection: () => void;
  onProperties: () => void;
  /**
   * Oeffnet den Explorer in einem eigenen Fenster. Nur gesetzt, wenn die
   * aufrufende Instanz den Knopf erlauben laesst — die Instanz im Fenster
   * uebergibt bewusst keinen Wert.
   */
  onOpenPopup?: () => void;
  t: Translate;
}

const TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  flexShrink: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

/**
 * Kopfzeile des Explorers: die Werkzeuge, die ohne Auswahl immer greifen, plus
 * die Auswahl-werkzeuge, die nur mit mindestens einem ausgewaehlten Knoten
 * sichtbar sind.
 *
 * New folder arbeitet auf dem aktuell angezeigten Ordner (`currentPath`) — das
 * ist der, den auch der Breadcrumb zeigt und in den der Upload landet. Die
 * Auswahl-werkzeuge arbeiten dagegen auf der Auswahl, weil sie ein Objekt
 * brauchen, dessen Elternordner sie als Startpunkt anbieten.
 */
function ExplorerToolbar({
  selection,
  uploadBusy,
  onNewFolder,
  onRefresh,
  refreshDone,
  onUpload,
  onCopyTo,
  onMoveTo,
  onClearSelection,
  onProperties,
  onOpenPopup,
  t,
}: ExplorerToolbarProps) {
  // `true` heisst: das Namensfeld ist offen. Der Text selbst liegt im
  // uncontrolled Input, nicht im State — das Formular wird genau einmal
  // abgeschickt und geschlossen, ein Render je Tastendruck waere Arbeit ohne
  // Gegenwert. Zusaetzlich loest es den Blur-Fall: bei einem kontrollierten
  // Feld raeumt `onBlur` den Entwurf, bevor der Submit-Handler ihn liest.
  const [draftOpen, setDraftOpen] = useState(false);
  const draftInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draftOpen) draftInputRef.current?.focus();
  }, [draftOpen]);

  return (
    <div
      role="toolbar"
      aria-label={t("files.toolbarLabel")}
      title={t("files.selectionHint")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 4px 4px 8px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {!draftOpen ? (
        <button
          type="button"
          className="omp-press"
          title={t("files.toolbarNewFolder")}
          aria-label={t("files.toolbarNewFolder")}
          style={TOOLBAR_BUTTON_STYLE}
          onClick={() => setDraftOpen(true)}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
          </svg>
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = (draftInputRef.current?.value ?? "").trim();
            setDraftOpen(false);
            if (name.length > 0) onNewFolder(name);
          }}
          style={{ display: "flex", alignItems: "center", gap: 3 }}
        >
          <input
            ref={draftInputRef}
            aria-label={t("files.newFolderName")}
            placeholder={t("files.newFolderName")}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDraftOpen(false); } }}
            onBlur={() => setDraftOpen(false)}
            style={{
              width: 120,
              height: 22,
              padding: "0 5px",
              boxSizing: "border-box",
              background: "var(--bg)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              outline: "none",
            }}
          />
        </form>
      )}

      <button
        type="button"
        className="omp-press"
        title={t("files.toolbarRefresh")}
        aria-label={t("files.toolbarRefresh")}
        style={{
          ...TOOLBAR_BUTTON_STYLE,
          color: refreshDone ? "#4ade80" : "var(--text-muted)",
          background: refreshDone ? "rgba(74,222,128,0.18)" : "transparent",
        }}
        onClick={onRefresh}
        onMouseEnter={(event) => { if (!refreshDone) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = refreshDone ? "rgba(74,222,128,0.18)" : "transparent";
        }}
      >
        {/* Der Haken ist die Bestaetigung fuer den Refresh. Ohne ihn sieht der
            Nutzer nicht, ob der Klick durch ist — der Baum tauscht sich im
            Bestandsfall inhaltlich nicht. */}
        {refreshDone ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-5.7-8.4" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="omp-press"
        title={t("files.toolbarUpload")}
        aria-label={t("files.toolbarUpload")}
        disabled={uploadBusy}
        style={{ ...TOOLBAR_BUTTON_STYLE, color: uploadBusy ? "var(--text-dim)" : "var(--text-muted)", cursor: uploadBusy ? "default" : "pointer" }}
        onClick={onUpload}
        onMouseEnter={(event) => { if (!uploadBusy) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 20h14" />
        </svg>
      </button>

      {/* Das grosse Fenster. Ohne `onOpenPopup` faellt der Knopf weg — das ist
          der Rekursionsschutz fuer die Instanz, die im Fenster selbst sitzt. */}
      {onOpenPopup && (
        <button
          type="button"
          className="omp-press"
          title={t("files.toolbarOpenWindow")}
          aria-label={t("files.toolbarOpenWindow")}
          style={TOOLBAR_BUTTON_STYLE}
          onClick={onOpenPopup}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18" />
            <path d="M8 14h8" />
          </svg>
        </button>
      )}

      {selection.length > 0 && (
        <>
          <span aria-hidden="true" style={{ width: 1, height: 14, margin: "0 3px", background: "var(--border)", flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {t("files.selectionCount", { count: selection.length })}
          </span>

          <button
            type="button"
            className="omp-press"
            title={t("files.toolbarCopyTo")}
            aria-label={t("files.toolbarCopyTo")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onCopyTo}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="11" height="12" rx="2" />
              <path d="M5 21V8a2 2 0 0 1 2-2h4" />
            </svg>
          </button>

          <button
            type="button"
            className="omp-press"
            title={t("files.toolbarMoveTo")}
            aria-label={t("files.toolbarMoveTo")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onMoveTo}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h13" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>

          {selection.length === 1 && (
            <a
              href={`/api/files/${encodeFilePathForApi(selection[0].path)}?type=download`}
              download
              title={t("files.toolbarDownload")}
              aria-label={t("files.toolbarDownload")}
              style={TOOLBAR_BUTTON_STYLE}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>
          )}

          <button
            type="button"
            className="omp-press"
            title={t("files.toolbarProperties")}
            aria-label={t("files.toolbarProperties")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onProperties}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5" />
              <path d="M12 8h.01" />
            </svg>
          </button>

          <button
            type="button"
            className="omp-press"
            title={t("files.clearSelection")}
            aria-label={t("files.clearSelection")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onClearSelection}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12" />
              <path d="m18 6-12 12" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  onNavigate,
  onContextMenu,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  selectedPaths,
  onToggleSelected,
  onOpenImage,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  onNavigate?: (fullPath: string) => void;
  onContextMenu: (fullPath: string, name: string, isDir: boolean, x: number, y: number) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  selectedPaths: Set<string>;
  onToggleSelected: (entry: SelectionEntry) => void;
  /**
   * Wird fuer Bilddateien statt `onOpenFile` aufgerufen, damit der Explorer
   * die grosse Vorschau oeffnen kann. Optional: fehlt der Callback, verhalten
   * sich Bilder wie zuvor und gehen in den normalen Datei-Tab.
   */
  onOpenImage?: (filePath: string, fileName: string) => void;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const selected = selectedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  /**
   * Der Knopf fuer die grosse Vorschau teilt sich den Weg mit dem Zeilen-Klick:
   * beide rufen `onOpenImage` auf, und beide setzen dieselbe Bildvorschau des
   * Explorers. Ohne den Callback (Aufrufer ohne eigene Vorschau) faellt der
   * Knopf weg, und der Klick auf die Zeile geht wie zuvor an `onOpenFile`.
   * Ordner sind nie Bilder, `isImagePath` entscheidet also nur noch ueber die
   * Endung.
   */
  const canPreviewImage = onOpenImage !== undefined && !node.isDir && isImagePath(node.name);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // Ein wiederhergestellter Zustand kann einen Ordner bereits als offen
  // ausweisen, ohne dass seine Kinder je geladen wurden — die Zeile ist frisch
  // gemountet, also ist `loaded` noch false und der Effekt oben greift nicht.
  // Ohne diesen zweiten Effekt stuende das Chevron auf offen und der Ordner
  // bliebe leer.
  //
  // Bewusst NUR beim Mount: der normale Weg zum Aufklappen ist der Chevron,
  // der `loadChildren` selbst aufruft. Ein Effekt auf `[open]` wuerde denselben
  // Ordner ein zweites Mal laden, weil `loaded` beim Rendern des Chevrons noch
  // false ist. Ein Ordner, der beim Mount offen ist, kann dagegen nur aus
  // `initialViewState` stammen.
  useEffect(() => {
    if (open && !loaded) loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = useCallback((event: React.MouseEvent) => {
    // Auswahl laeuft ueber Strg/Cmd-Klick, nicht ueber den einfachen Klick.
    // Ein Dateimanager lebt davon, dass ein Klick eine Datei oeffnet; nimmt man
    // das fuer die Auswahl, muss jeder Nutzer zweimal klicken, um etwas zu
    // sehen. Der Modifikator kostet nur einen Finger und ist zugleich die
    // gewohnte Mehrfachauswahl ohne weitere Klickpflege — ein Checkbox je
    // Zeile wuerde bei tiefen Baeumen die Namensspalte verschieben.
    if (event.ctrlKey || event.metaKey) {
      onToggleSelected({ path: node.fullPath, name: node.name, isDir: node.isDir });
      return;
    }
    if (node.isDir) {
      // Click on a directory navigates into it (replaces the explorer root
      // view). The chevron handles expand/collapse instead, so this matches
      // a typical file-manager: row click = open, chevron = peek.
      onNavigate?.(node.fullPath);
    } else if (onOpenImage && isImagePath(node.name)) {
      onOpenImage(node.fullPath, node.name);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.fullPath, node.isDir, node.name, onNavigate, onOpenFile, onOpenImage, onToggleSelected]);

  const handleChevronClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const next = !open;
    onToggleExpanded(node.fullPath, next);
    if (next && !loaded) loadChildren();
  }, [loaded, loadChildren, node.fullPath, open, onToggleExpanded]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(node.fullPath, node.name, node.isDir, event.clientX, event.clientY);
  }, [node.fullPath, node.isDir, node.name, onContextMenu]);

  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-selected={selected ? "true" : undefined}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          // Auswahl schlaegt Hover: eine markierte Zeile soll auch dann
          // markiert bleiben, wenn der Zeiger sie gerade nicht beruehrt.
          background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={open ? t("files.collapseFolder") : t("files.expandFolder")}
            onClick={handleChevronClick}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, cursor: "pointer" }}
          >
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
            >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          </span>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            className="omp-press-scale"
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? ROW_ACTION_RIGHT_MENTION_FILE : ROW_ACTION_RIGHT_MENTION_DIR,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {canPreviewImage && hovered && (
          <button
            className="omp-press-scale"
            onClick={(e) => {
              // Ohne Halt ruft der Klick auf den Knopf den Zeilen-Klick auf und
              // oeffnet dieselbe Vorschau ein zweites Mal.
              e.stopPropagation();
              onOpenImage?.(node.fullPath, node.name);
            }}
            title={t("files.openImageLarge")}
            aria-label={t("files.openImageLarge")}
            style={{
              position: "absolute",
              right: ROW_ACTION_RIGHT_IMAGE,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              width: 20,
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <ImageOpenIcon />
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: ROW_ACTION_RIGHT_DOWNLOAD,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              onContextMenu={onContextMenu}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              selectedPaths={selectedPaths}
              onToggleSelected={onToggleSelected}
              onOpenImage={onOpenImage}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Breadcrumb({
  currentPath,
  projectRoot,
  homeDir,
  onNavigate,
  onNavigateUp,
  onNavigateHome,
}: {
  currentPath: string;
  projectRoot: string;
  homeDir: string;
  onNavigate: (fullPath: string) => void;
  onNavigateUp: () => void;
  onNavigateHome: () => void;
}) {
  const canGoUp = currentPath !== "/" && currentPath !== projectRoot && getFileDirectory(currentPath) !== currentPath;
  const atHome = normalizeFilePathSlashes(currentPath) === normalizeFilePathSlashes(homeDir);
  // Build segments by splitting the absolute path. Skip the leading empty
  // entry from the leading slash so segment 0 is the first real directory.
  const segments: Array<{ name: string; fullPath: string }> = [];
  const parts = currentPath.split("/").filter(Boolean);
  let running = currentPath.startsWith("/") ? "" : "";
  for (const part of parts) {
    running = running === "" && currentPath.startsWith("/") ? `/${part}` : `${running}/${part}`;
    segments.push({ name: part, fullPath: running });
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 4px 6px 8px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        overflowX: "auto",
        whiteSpace: "nowrap",
        scrollbarWidth: "thin",
      }}
    >
      <button
      className="omp-press"
        type="button"
        onClick={onNavigateHome}
        disabled={atHome}
        title={`Home (${homeDir})`}
        aria-label={`Home directory ${homeDir}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          padding: 0,
          background: "transparent",
          border: "none",
          borderRadius: 4,
          color: atHome ? "var(--text-dim)" : "var(--text-muted)",
          cursor: atHome ? "default" : "pointer",
          opacity: atHome ? 0.5 : 1,
        }}
        onMouseEnter={(event) => { if (!atHome) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>
      <button
      className="omp-press"
        type="button"
        onClick={onNavigateUp}
        disabled={!canGoUp}
        title="Up one directory"
        aria-label="Up one directory"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          padding: 0,
          background: "transparent",
          border: "none",
          borderRadius: 4,
          color: canGoUp ? "var(--text-muted)" : "var(--text-dim)",
          cursor: canGoUp ? "pointer" : "default",
          opacity: canGoUp ? 1 : 0.4,
          marginRight: 4,
        }}
        onMouseEnter={(event) => { if (canGoUp) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span key={segment.fullPath} style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}>
            <button
            className="omp-press"
              type="button"
              onClick={() => onNavigate(segment.fullPath)}
              title={segment.fullPath}
              style={{
                padding: "1px 5px",
                background: "transparent",
                border: "none",
                borderRadius: 3,
                color: isLast ? "var(--text)" : "var(--text-muted)",
                fontWeight: isLast ? 500 : 400,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                maxWidth: 180,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(event) => { if (!isLast) event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            >
              {segment.name}
            </button>
            {!isLast && <span style={{ color: "var(--text-dim)" }}>/</span>}
          </span>
        );
      })}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onRefresh,
  changesCollapsed,
  onChangesCountChange,
  initialViewState,
  onViewStateChange,
  allowPopup = true,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(initialViewState?.expandedPaths ?? new Set());
  // The directory currently shown at the top of the tree. Defaults to the
  // `cwd` prop (the project root) and updates when the user navigates up or
  // down via the breadcrumb, the Up button, or clicking a folder row. The
  // external `cwd` prop is the project root and never changes from inside.
  // `initialViewState` hat Vorrang: es ist der Blick, den eine gerade neu
  // gemountete Instanz (das grosse Fenster) uebernimmt.
  const [currentPath, setCurrentPath] = useState<string>(initialViewState?.currentPath ?? cwd);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  // Bestaetigung fuer den Refresh-Button. Zwei Sekunden gruen, dann faellt der
  // Haken wieder weg — ohne sie bliebe bei unveraendertem Baum kein Merkmal,
  // an dem der Nutzer den Klick sieht.
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [homeDir, setHomeDir] = useState<string>("/");
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  // Rechtsklick-Ziel in Viewport-Koordinaten. `null` heisst: Menue geschlossen.
  const [menuTarget, setMenuTarget] = useState<FileMenuTarget | null>(null);
  // Auswahl fuer die Toolbar. Als Map nach Pfad, weil das Umschalten einer
  // Zeile ein Lookup und eine Ersetzung ist und die Reihenfolge der Auswahl
  // fuer die Werkzeuge keine Rolle spielt.
  const [selection, setSelection] = useState<Map<string, SelectionEntry>>(new Map());
  // Zielordner-Dialog der Toolbar. Bewusst getrennt vom Kontextmenue-Dialog:
  // beide nutzen denselben Dialog, aber unterschiedliche Quellen und
  // unterschiedliche Urspruenge, und ein gemeinsamer State wuerde beim
  // Schliessen des einen den anderen ungefragt mitreissen.
  const [toolbarTransfer, setToolbarTransfer] = useState<"copy" | "move" | null>(null);
  const [propertiesTarget, setPropertiesTarget] = useState<SelectionEntry | null>(null);
  // Grosse Bildvorschau. Eine Datei im Ziel reicht, solange keine Serie
  // geoeffnet wurde; dann liefert der Dialog onNext/onPrev selbst.
  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null);
  // GROSSES FENSTER. Der Blick auf den Baum des Fensters (`popupViewState`)
  // lebt hier, nicht in der Fenster-Komponente: das Fenster wird beim
  // Schliessen aus dem DOM entfernt und verliere damit seinen eigenen State.
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupViewState, setPopupViewState] = useState<ExplorerViewState | null>(null);
  const [actionNotice, setActionNotice] = useState<FileActionNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  /**
   * Meldet Pfad und aufgeklappte Aeste nach aussen, damit die aufrufende
   * Instanz sie als Startzustand fuer die naechste bekommt.
   *
   * Der Effekt haengt an genau diesen zwei Werten, nicht am Callback: die
   * aufrufende Instanz gibt bei jedem Rendern eine neue Pfeilfunktion, und
   * haenge der Effekt daran, meldete die Instanz ihren Zustand in jedem
   * Rendern zurueck und wuerde sich selbst wieder aufrufen. `sameViewState`
   * faengt das zusätzlich ab, sodass auch inhaltlich gleiche Meldungen den
   * Zustand der aufrufenden Seite unberuehrt lassen.
   */
  useEffect(() => {
    onViewStateChange?.({ currentPath, expandedPaths });
  }, [currentPath, expandedPaths, onViewStateChange]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  // Als Set, weil der Baum damit pro Zeile nur einen Lookup macht. Aus der
  // Auswahl-Map abgeleitet, damit beide Zustandsformen nicht auseinanderlaufen.
  const selectedPaths = useMemo(() => new Set(selection.keys()), [selection]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleNavigate = useCallback((fullPath: string) => {
    setCurrentPath(fullPath);
    // Navigation collapses the previously expanded branches so the new
    // starting point is a clean view; the user can re-expand from there.
    setExpandedPaths(new Set());
  }, []);

  const handleNavigateUp = useCallback(() => {
    setCurrentPath((prev) => {
      const parent = getFileDirectory(prev);
      return parent === prev ? prev : parent;
    });
    setExpandedPaths(new Set());
  }, []);

  const handleNavigateHome = useCallback(() => {
    setCurrentPath(homeDir);
    setExpandedPaths(new Set());
  }, [homeDir]);

  // Das Menue haengt an einer Zeile, nicht an einem Element: der Pfad wandert
  // mit dem Navigieren mit, und ein Klick auf Breadcrumb, Leerflaeche oder eine
  // andere Zeile schliesst es, ohne dass diese Flaechen je einen Handler
  // bekommen. Das `null` hier ist derselbe Zustand, den das Panel selbst
  // ueber `onClose` zurueckmeldet.
  const handleOpenContextMenu = useCallback((
    fullPath: string,
    name: string,
    isDir: boolean,
    x: number,
    y: number,
  ) => {
    setMenuTarget({ x, y, path: fullPath, name, isDir });
  }, []);

  const closeContextMenu = useCallback(() => {
    setMenuTarget(null);
  }, []);

  const handleToggleSelected = useCallback((entry: SelectionEntry) => {
    setSelection((previous) => {
      const next = new Map(previous);
      if (next.has(entry.path)) next.delete(entry.path); else next.set(entry.path, entry);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Map());
  }, []);

  /**
   * Nimmt den gemeldeten Blick des Fenster-Explorers entgegen, aber nur wenn er
   * sich wirklich geaendert hat. Ohne diese Pruefung wuerde jedes Auf- und
   * Zuklappen einen neuen Zustand mit gleicher Bedeutung setzen und die
   * Seitenleiste neu rendern, waehrend der Inhalt unveraendert bleibt.
   */
  const handlePopupViewState = useCallback((view: ExplorerViewState) => {
    setPopupViewState((previous) => previous && sameViewState(previous, view) ? previous : view);
  }, []);

  const openImagePreview = useCallback((filePath: string, name: string) => {
    setImagePreview({ path: filePath, name });
  }, []);

  /**
   * Oeffnet den Explorer im grossen Fenster. Der mitgegebene Blick ist der
   * Stand, den der zuletzt offene Fenster-Explorer gemeldet hat — er ist beim
   * ersten Oeffnen `null`, dann startet das Fenster bei `cwd`.
   */
  const openPopup = useCallback(() => {
    setPopupOpen(true);
  }, []);

  const handleMutated = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
  }, []);

  // Fehler bleiben stehen, bis sie weggeklickt werden; Erfolgsmeldungen
  // verschwinden von selbst, weil sie nur eine Bestaetigung sind.
  const handleActionNotice = useCallback((notice: FileActionNotice) => {
    clearTimeout(noticeTimerRef.current ?? undefined);
    noticeTimerRef.current = null;
    setActionNotice(notice);
    if (notice.kind === "success") {
      noticeTimerRef.current = setTimeout(() => {
        noticeTimerRef.current = null;
        setActionNotice(null);
      }, 3200);
    }
  }, []);

  useEffect(() => () => clearTimeout(noticeTimerRef.current ?? undefined), []);

  /**
   * Neuer Ordner im aktuell angezeigten Verzeichnis. Dieselbe Route wie das
   * Kontextmenue (`POST ?type=mkdir`, Pfad = Elternordner, `name` = Segment),
   * damit beide Wege dieselbe Validierung durchlaufen. Die Namenspruefung
   * steht hier, weil die Toolbar keinen Formularschritt hat, in dem sie
   * sichtbar waere.
   */
  const handleNewFolder = useCallback((name: string) => {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      handleActionNotice({ kind: "error", text: t("files.invalidName") });
      return;
    }
    void fetch(`/api/file-actions/${encodeFilePathForApi(currentPath)}?type=mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as { error?: string; reason?: string };
        if (!res.ok) {
          const message = data.error ?? data.reason ?? `HTTP ${res.status}`;
          handleActionNotice({ kind: "error", text: data.error && data.reason && data.reason !== data.error ? `${message} (${data.reason})` : message });
          return;
        }
        setTreeRefreshKey((key) => key + 1);
        handleActionNotice({ kind: "success", text: t("files.folderCreated", { name }) });
      })
      .catch((cause: unknown) => {
        handleActionNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
      });
  }, [currentPath, handleActionNotice, t]);

  /**
   * Copy/Move aus der Toolbar. Die API kennt pro Anfrage genau eine Quelle,
   * deshalb laeuft bei mehreren markierten Eintraegen eine Kette: der Dialog
   * bleibt fuer alle offen und schliesst erst, wenn der letzte durch ist.
   */
  const handleToolbarTransferConfirm = useCallback((destination: string) => {
    const pending = [...selection.values()];
    if (pending.length === 0) { setToolbarTransfer(null); return; }
    const kind = toolbarTransfer ?? "copy";
    void (async () => {
      for (const entry of pending) {
        let result: { ok: boolean; text: string };
        try {
          const res = await fetch(`/api/file-actions/${encodeFilePathForApi(entry.path)}?type=${kind}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destination }),
          });
          const data = await res.json().catch(() => ({})) as { error?: string; reason?: string };
          if (!res.ok) {
            const message = data.error ?? data.reason ?? `HTTP ${res.status}`;
            result = { ok: false, text: data.error && data.reason && data.reason !== data.error ? `${message} (${data.reason})` : message };
          } else {
            result = {
              ok: true,
              text: kind === "move" ? t("files.movedTo", { destination }) : t("files.copiedTo", { destination }),
            };
          }
        } catch (cause) {
          result = { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
        }
        if (!result.ok) {
          setToolbarTransfer(null);
          handleActionNotice({ kind: "error", text: result.text });
          return;
        }
        handleActionNotice({ kind: "success", text: result.text });
      }
      setToolbarTransfer(null);
      setSelection(new Map());
      setTreeRefreshKey((key) => key + 1);
    })();
  }, [handleActionNotice, selection, t, toolbarTransfer]);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  // Laedt den Baum neu, meldet nach aussen (Git-Stand im Datei-Tab) und zeigt
  // den Haken. Der Timer wird vorher geraeumt, damit ein zweiter Klick die
  // Anzeige nicht vorzeitig zurueckstellt.
  const handleRefresh = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
    onRefresh?.();
    setRefreshDone(true);
    clearTimeout(refreshDoneTimerRef.current ?? undefined);
    refreshDoneTimerRef.current = setTimeout(() => {
      refreshDoneTimerRef.current = null;
      setRefreshDone(false);
    }, 2000);
  }, [onRefresh]);

  useEffect(() => () => clearTimeout(refreshDoneTimerRef.current ?? undefined), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/home")
      .then((res) => res.ok ? res.json() as Promise<{ home: string }> : null)
      .then((data) => {
        if (!cancelled && data?.home) setHomeDir(data.home);
      })
      .catch(() => { /* keep the default of `/` */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Der ERSTE Lauf ist kein cwd-Wechsel. `prevCwdRef` ist absichtlich `null`
    // statt `cwd`, damit sich beides unterscheiden laesst: als Wechsel gewertet
    // wuerde der erste Lauf genau den Blick aus `initialViewState` wieder
    // wegraeumen, den diese Instanz gerade uebernommen hat. Zurueckgesetzt
    // wird nur beim echten Wechsel des Projektordners; die Ladeanzeige
    // erscheint in beiden Faellen.
    const firstRun = prevCwdRef.current === null;
    const cwdChanged = !firstRun && prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state and snap navigation back to the project root
    // when the externally-provided cwd changes (e.g. user picked a new
    // project). Same trigger also clears uploads and highlights.
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setCurrentPath(cwd);
    }

    setLoading(firstRun || cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(currentPath)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, currentPath, refreshKey, treeRefreshKey]);

  // Auto-refresh the listing every 5 seconds. Bumping treeRefreshKey
  // re-runs the entry fetch above (and the git-status effect below) without
  // disturbing navigation state — expanded paths, currentPath, and
  // highlights all survive the round-trip.
  useEffect(() => {
    const interval = setInterval(() => {
      setTreeRefreshKey((key) => key + 1);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div
      style={{ minHeight: "100%" }}
      // Rechtsklick auf die Wurzelflaeche: kein Systemmenue, das Menue
      // gehoert zu einer Zeile, nicht zu jedem freien Stueck des Panels.
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                className="omp-press"
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {!changesCollapsed && gitFiles.length > 0 && (
        <div style={{ padding: "0 4px 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 12 }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => (
            <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
          ))}
        </div>
      )}

      {/* Die Werkzeuge stehen ueber der Aenderungsliste und dem Baum, nicht
          darin: mit aufgeklappter Liste waeren Refresh und Upload sonst weg. */}
      {!loading && !error && (
        <div style={{ padding: "2px 4px 0" }}>
          <ExplorerToolbar
            selection={[...selection.values()]}
            uploadBusy={uploadBusy}
            onNewFolder={handleNewFolder}
            onRefresh={handleRefresh}
            refreshDone={refreshDone}
            onUpload={() => { if (!uploadBusy) uploadInputRef.current?.click(); }}
            onCopyTo={() => setToolbarTransfer("copy")}
            onMoveTo={() => setToolbarTransfer("move")}
            onClearSelection={clearSelection}
            onProperties={() => {
              const [first] = [...selection.values()];
              if (first) setPropertiesTarget(first);
            }}
            onOpenPopup={allowPopup ? openPopup : undefined}
            t={t}
          />
        </div>
      )}

      {(changesCollapsed || gitFiles.length === 0) && (
        <div style={{ padding: "2px 4px" }}>
          {loading ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
          ) : (
            <>
              <Breadcrumb
                currentPath={currentPath}
                projectRoot={cwd}
                homeDir={homeDir}
                onNavigate={handleNavigate}
                onNavigateUp={handleNavigateUp}
                onNavigateHome={handleNavigateHome}
              />
              {roots.map((node) => (
                <TreeNode
                  key={node.fullPath}
                  node={node}
                  depth={0}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                  onAtMention={onAtMention}
                  expandedPaths={expandedPaths}
                  onToggleExpanded={handleToggleExpanded}
                  onNavigate={handleNavigate}
                  onContextMenu={handleOpenContextMenu}
                  refreshToken={refreshToken}
                  highlightedPaths={highlightedPaths}
                  gitStatusByPath={gitStatusByPath}
                  changedDirectoryPaths={changedDirectoryPaths}
                  selectedPaths={selectedPaths}
                  onToggleSelected={handleToggleSelected}
                  onOpenImage={openImagePreview}
                  t={t}
                />
              ))}
            </>
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}

      {menuTarget && (
        <FileContextMenu
          target={menuTarget}
          onClose={closeContextMenu}
          onMutated={handleMutated}
          onNotify={handleActionNotice}
          onOpenImage={openImagePreview}
        />
      )}
      {toolbarTransfer && selection.size > 0 && (
        // Startpunkt ist der Elternordner des ersten markierten Eintrags: das
        // ist der Ordner, aus dem heraus man am ehesten ein anderes Ziel waehlt.
        <FileBrowserDialog
          open
          title={toolbarTransfer === "move"
            ? t("files.moveDialogTitle", { name: [...selection.values()][0].name })
            : t("files.copyDialogTitle", { name: [...selection.values()][0].name })}
          initialPath={getFileDirectory([...selection.values()][0].path) || "/"}
          confirmLabel={toolbarTransfer === "move" ? t("files.moveHere") : t("files.copyHere")}
          onCancel={() => setToolbarTransfer(null)}
          onConfirm={handleToolbarTransferConfirm}
        />
      )}
      {propertiesTarget && (
        <PropertiesDialog target={propertiesTarget} onClose={() => setPropertiesTarget(null)} t={t} />
      )}
      {imagePreview && (
        <FileImagePreview
          open
          filePath={imagePreview.path}
          fileName={imagePreview.name}
          onClose={() => setImagePreview(null)}
        />
      )}
      {popupOpen && (
        // Beim Schliessen faellt `popupOpen` auf `false` und der ganze Baum
        // wird aus dem DOM entfernt. `popupViewState` ueberlebt das und ist
        // der Startzustand des naechsten Fensters.
        <FileExplorerWindow
          cwd={cwd}
          changesCollapsed={changesCollapsed}
          initialViewState={popupViewState ?? undefined}
          onViewStateChange={handlePopupViewState}
          onClose={() => setPopupOpen(false)}
          t={t}
        />
      )}
      {actionNotice && (
        <FileActionToast notice={actionNotice} onDismiss={() => setActionNotice(null)} />
      )}
    </div>
  );
});
