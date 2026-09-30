"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";

/** Rechtsklick-Ziel einer Baumzeile, x/y in Viewport-Koordinaten. */
export interface FileMenuTarget {
  x: number;
  y: number;
  path: string;
  name: string;
  isDir: boolean;
}

/** Kurzhinweis zu einer Dateiaktion, unten rechts eingeblendet. */
export interface FileActionNotice {
  kind: "success" | "error";
  text: string;
}

/**
 * Was eine Dateiaktion zurueckgibt. Die API lehnt Regeln des Dateisystems ab
 * — vorhandenes Ziel, Ordner in sich selbst, fehlende Schreibberechtigung —
 * das sind erwartete Antworten und keine Programmfehler, deshalb kein Wurf.
 */
type ActionResult = { ok: true } | { ok: false; error: string };

interface FileActionResponse {
  ok?: boolean;
  path?: string;
  previousPath?: string;
  error?: string;
  reason?: string;
}

type MenuPhase = "root" | "rename" | "new-folder" | "confirm-delete";
type MenuAction = "copy-path" | "new-folder" | "rename" | "copy-to" | "move-to" | "delete";
type TransferKind = "copy" | "move";

interface FileContextMenuProps {
  target: FileMenuTarget;
  onClose: () => void;
  onMutated: () => void;
  onNotify: (notice: FileActionNotice) => void;
}

/** Rand zwischen Panel und Viewportkante. */
const MENU_MARGIN = 8;
const MENU_MIN_WIDTH = 172;
const MENU_MAX_WIDTH = 240;
const PANEL_CONTENT_WIDTH = 208;

const MENU_ITEM_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 9px",
  background: "transparent",
  border: "none",
  borderRadius: 4,
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
  whiteSpace: "nowrap",
};

const INPUT_STYLE: React.CSSProperties = {
  width: PANEL_CONTENT_WIDTH,
  maxWidth: "100%",
  boxSizing: "border-box",
  height: 24,
  padding: "0 6px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};

/** Beschriftung im Kopf der Formularschritte; Pfad darunter als Kontext. */
const CONTEXT_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-dim)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: PANEL_CONTENT_WIDTH,
};

function secondaryButtonStyle(): React.CSSProperties {
  return {
    height: 22,
    padding: "0 8px",
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

function primaryButtonStyle(): React.CSSProperties {
  return {
    height: 22,
    padding: "0 8px",
    border: "1px solid var(--accent)",
    borderRadius: 4,
    background: "var(--accent)",
    color: "var(--accent-fg, #fff)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

function dangerButtonStyle(): React.CSSProperties {
  return { ...secondaryButtonStyle(), border: "1px solid var(--danger)", color: "var(--danger)" };
}

/** Formularschritte teilen sich Aufbau, Fusszeile und Bestaetigungsknoten. */
const FORM_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 3 };
const FORM_FOOTER_STYLE: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 5 };

/** `error` plus `reason`, damit ein 403 die Begruendung nicht verschluckt. */
function describeApiError(data: FileActionResponse, status: number): string {
  const message = data.error ?? data.reason ?? `HTTP ${status}`;
  if (!data.error || !data.reason || data.reason === data.error) return message;
  return `${message} (${data.reason})`;
}

/**
 * POST-Zweig von /api/file-actions. Der Pfad adressiert die Quelle, das Ziel
 * kommt als absoluter Verzeichnispfad im Body.
 */
async function postFileAction(
  targetPath: string,
  type: "mkdir" | "rename" | TransferKind,
  body: Record<string, string>,
): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/file-actions/${encodeFilePathForApi(targetPath)}?type=${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as FileActionResponse;
    if (!res.ok) return { ok: false, error: describeApiError(data, res.status) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** DELETE-Zweig von /api/file-actions, entfernt rekursiv. */
async function deleteEntry(targetPath: string): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/file-actions/${encodeFilePathForApi(targetPath)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({})) as FileActionResponse;
    if (!res.ok) return { ok: false, error: describeApiError(data, res.status) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.85 }}>
      {children}
    </svg>
  );
}

interface MenuItem {
  action: MenuAction;
  label: string;
  icon: ReactNode;
  danger?: boolean;
}

/**
 * Rechtsklick-Menue fuer eine Zeile im Dateibaum.
 *
 * Das Panel ist `position: fixed` und misst sich nach dem Mount, um sich an
 * den Viewport-Rand zu klemmen, statt rechts oder unten herauszuschieben. Alle
 * Aktionen schliessen das Menue; Erfolg und Fehler melden sie ueber
 * `onMutated` bzw. `onNotify` nach aussen, damit der Aufrufer das Ergebnis an
 * einer Stelle behandelt statt in jedem Zweig des Panels.
 */
export function FileContextMenu({ target, onClose, onMutated, onNotify }: FileContextMenuProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<MenuPhase>("root");
  const [draft, setDraft] = useState("");
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Erst messen, dann setzen: der Layout-Effekt laeuft vor dem Paint, das
  // Panel erscheint also direkt an seiner endgueltigen Position. Die Abhaengig-
  // keit von `phase` faengt den Groessenwechsel der Formularschritte ein.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const { width, height } = panel.getBoundingClientRect();
    setPlacement({
      left: Math.min(Math.max(target.x, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN)),
      top: Math.min(Math.max(target.y, MENU_MARGIN), Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN)),
    });
  }, [phase, target.x, target.y]);

  useLayoutEffect(() => {
    if (phase === "root") {
      panelRef.current?.focus();
      return;
    }
    if (phase === "rename") {
      draftRef.current?.focus();
      draftRef.current?.select();
      return;
    }
    // Die Bestaetigung startet auf "Abbrechen" und nicht auf dem roten Knopf,
    // damit ein gewohnheitsmaessiges Enter nichts loescht.
    if (phase === "confirm-delete") cancelRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Die Position haengt am Viewport, nicht am Element: bei Scroll oder
    // Fenstergroessenaenderung waere sie veraltet, also schliessen statt
    // springen.
    const onViewportChange = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [onClose]);

  const moveFocus = useCallback((delta: number) => {
    const items = panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])");
    if (!items || items.length === 0) return;
    const current = Array.from(items).findIndex((item) => item === document.activeElement);
    const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
    items[(base + delta + items.length) % items.length]?.focus();
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // In den Formularschritten heisst Escape "zurueck zur Liste", nicht
      // "Menue schliessen" — sonst verliert man den Weg zum naechsten Schritt.
      event.preventDefault();
      event.stopPropagation();
      if (phase === "root") onClose(); else setPhase("root");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  }, [moveFocus, onClose, phase]);

  const run = useCallback((work: () => Promise<ActionResult>, notice: string) => {
    onClose();
    void work().then((result) => {
      if (result.ok) {
        onMutated();
        onNotify({ kind: "success", text: notice });
        return;
      }
      onNotify({ kind: "error", text: result.error });
    });
  }, [onClose, onMutated, onNotify]);

  const handleCopyPath = useCallback(() => {
    onClose();
    void copyText(target.path).then(
      () => onNotify({ kind: "success", text: t("files.copyPathDone") }),
      () => onNotify({ kind: "error", text: t("files.copyPathFailed") }),
    );
  }, [onClose, onNotify, t, target.path]);

  const handleSubmitName = useCallback((value: string) => {
    const name = value.trim();
    const isRename = phase === "rename";
    onClose();
    // Ein Name ist genau ein Pfadsegment. Die API lehnt `../` ohnehin ab, aber
    // ein Versuch von hier aus ist eine vermeidbare Anfrage mit einer
    // technischen statt einer verstaendlichen Fehlermeldung.
    if (name.length === 0 || name === "." || name === ".."
      || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      onNotify({ kind: "error", text: t("files.invalidName") });
      return;
    }
    // Sowohl rename als auch mkdir adressieren ueber den Pfad die Quelle: der
    // Pfad ist der umzubenennende Eintrag bzw. der Ordner, in dem der neue
    // Ordner entsteht.
    run(
      () => postFileAction(target.path, isRename ? "rename" : "mkdir", { name }),
      isRename ? t("files.renamedTo", { name }) : t("files.folderCreated", { name }),
    );
  }, [onClose, onNotify, phase, run, t, target.path]);

  const handleTransfer = useCallback((kind: TransferKind) => {
    const source = target.path;
    // Phase 3 ersetzt den nativen Prompt durch eine Auswahl im Explorer.
    const answer = window.prompt(
      kind === "copy" ? t("files.promptCopyTo", { name: target.name }) : t("files.promptMoveTo", { name: target.name }),
      "",
    );
    onClose();
    if (answer === null) return;
    const destination = answer.trim();
    if (destination.length === 0) return;
    // Copy und Move verlangen ein absolutes Zielverzeichnis.
    if (!(destination.startsWith("/") || destination.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(destination))) {
      onNotify({ kind: "error", text: t("files.invalidDestination") });
      return;
    }
    run(
      () => postFileAction(source, kind, { destination }),
      kind === "copy" ? t("files.copiedTo", { destination }) : t("files.movedTo", { destination }),
    );
  }, [onClose, onNotify, run, t, target.name, target.path]);

  const handleDelete = useCallback(() => {
    run(
      () => deleteEntry(target.path),
      t("files.deleteDone", { name: target.name }),
    );
  }, [run, t, target.name, target.path]);

  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [];
    if (target.isDir) {
      list.push({
        action: "new-folder",
        label: t("files.contextNewFolder"),
        icon: <MenuIcon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="9.5" y1="13.5" x2="14.5" y2="13.5" /></MenuIcon>,
      });
    } else {
      list.push({
        action: "copy-path",
        label: t("files.contextCopyPath"),
        icon: <MenuIcon><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></MenuIcon>,
      });
    }
    list.push({
      action: "rename",
      label: t("files.contextRename"),
      icon: <MenuIcon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></MenuIcon>,
    });
    if (target.isDir) {
      list.push({
        action: "copy-to",
        label: t("files.contextCopyTo"),
        icon: <MenuIcon><rect x="9" y="3" width="11" height="12" rx="2" /><path d="M5 21V8a2 2 0 0 1 2-2h4" /></MenuIcon>,
      });
      list.push({
        action: "move-to",
        label: t("files.contextMoveTo"),
        icon: <MenuIcon><path d="M5 12h13" /><polyline points="13 6 19 12 13 18" /></MenuIcon>,
      });
    }
    list.push({
      action: "delete",
      label: t("files.contextDelete"),
      icon: <MenuIcon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></MenuIcon>,
      danger: true,
    });
    return list;
  }, [t, target.isDir]);

  const selectAction = useCallback((action: MenuAction) => {
    if (action === "copy-path") { handleCopyPath(); return; }
    if (action === "new-folder") { setDraft(""); setPhase("new-folder"); return; }
    if (action === "rename") { setDraft(target.name); setPhase("rename"); return; }
    if (action === "copy-to") { handleTransfer("copy"); return; }
    if (action === "move-to") { handleTransfer("move"); return; }
    setPhase("confirm-delete");
  }, [handleCopyPath, handleTransfer, target.name]);

  const panelLabel = phase === "rename"
    ? t("files.contextRename")
    : phase === "new-folder"
      ? t("files.contextNewFolder")
      : phase === "confirm-delete"
        ? t("files.contextDelete")
        : t("files.contextLabel", { name: target.name });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role={phase === "root" ? "menu" : "dialog"}
      aria-label={panelLabel}
      aria-modal={phase === "root" ? undefined : true}
      className="omp-pop-in"
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: placement?.left ?? target.x,
        top: placement?.top ?? target.y,
        zIndex: 320,
        minWidth: MENU_MIN_WIDTH,
        maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${MENU_MARGIN * 2}px))`,
        display: "flex",
        flexDirection: "column",
        padding: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
        outline: "none",
      }}
    >
      {phase === "root" && items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className="omp-press"
          onClick={() => selectAction(item.action)}
          style={item.danger ? { ...MENU_ITEM_STYLE, color: "var(--danger)" } : MENU_ITEM_STYLE}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          {item.icon}
          <span style={{ flex: 1 }}>{item.label}</span>
        </button>
      ))}

      {(phase === "rename" || phase === "new-folder") && (
        <form
          aria-label={panelLabel}
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmitName(draft);
          }}
          style={FORM_STYLE}
        >
          <span title={target.path} style={CONTEXT_STYLE}>
            {phase === "rename" ? target.name : target.path}
          </span>
          <input
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={panelLabel}
            placeholder={phase === "new-folder" ? t("files.newFolderName") : undefined}
            style={INPUT_STYLE}
          />
          <div style={FORM_FOOTER_STYLE}>
            <button ref={cancelRef} type="button" className="omp-press" onClick={() => setPhase("root")} style={secondaryButtonStyle()}>
              {t("files.cancel")}
            </button>
            <button type="submit" className="omp-press-tint" style={primaryButtonStyle()}>
              {phase === "rename" ? t("files.actionRename") : t("files.actionCreate")}
            </button>
          </div>
        </form>
      )}

      {phase === "confirm-delete" && (
        <div aria-label={panelLabel} style={{ ...FORM_STYLE, maxWidth: PANEL_CONTENT_WIDTH + 16 }}>
          <span style={{ fontSize: 11, lineHeight: 1.35, color: "var(--text)", overflowWrap: "anywhere" }}>
            {t("files.confirmDelete", { name: target.name })}
          </span>
          {target.isDir && (
            <span style={{ fontSize: 10, lineHeight: 1.35, color: "var(--danger)", overflowWrap: "anywhere" }}>
              {t("files.confirmDeleteFolder")}
            </span>
          )}
          <div style={FORM_FOOTER_STYLE}>
            <button ref={cancelRef} type="button" className="omp-press" onClick={() => setPhase("root")} style={secondaryButtonStyle()}>
              {t("files.cancel")}
            </button>
            <button type="button" className="omp-press" onClick={handleDelete} style={dangerButtonStyle()}>
              {t("files.contextDelete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Kurzhinweis unten rechts zu Erfolg oder Fehler einer Dateiaktion. */
export function FileActionToast({ notice, onDismiss }: { notice: FileActionNotice; onDismiss: () => void }) {
  const { t } = useI18n();
  const isError = notice.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className="omp-slide-in-up"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 900,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        maxWidth: 360,
        padding: "7px 8px",
        background: "var(--bg-panel)",
        border: `1px solid color-mix(in srgb, ${isError ? "var(--danger)" : "var(--accent)"} 52%, var(--border))`,
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
      }}
    >
      <span style={{ minWidth: 0, flex: 1, fontSize: 11, lineHeight: 1.35, color: isError ? "var(--danger)" : "var(--text)", overflowWrap: "anywhere" }}>
        {notice.text}
      </span>
      <button
        type="button"
        className="omp-press"
        onClick={onDismiss}
        title={t("files.dismissError")}
        aria-label={t("files.dismissError")}
        style={{ width: 18, height: 18, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </svg>
      </button>
    </div>
  );
}
