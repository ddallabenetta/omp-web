"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./FileImagePreview.module.css";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";

export interface FileImagePreviewProps {
  /** true rendert Backdrop und Panel, false rendert gar nichts. */
  open: boolean;
  /** Absoluter Pfad des Bildes. */
  filePath: string;
  /** Anzeigename; dient als `alt` und als Kopfzeilentext. */
  fileName: string;
  onClose: () => void;
  /** Naechstes Bild. Ohne diese beiden Callbacks bleiben Navigation und Pfeiltasten aus. */
  onNext?: () => void;
  /** Vorheriges Bild. */
  onPrev?: () => void;
  /** Position in der Bildserie, 1-basiert; reine Anzeige. */
  currentIndex?: number;
  /** Laenge der Bildserie; die Zaehlanzeige erscheint erst ab zwei Bildern. */
  total?: number;
}

type LoadState = "loading" | "loaded" | "error";

/** Zoomfaktor-Faktoren. `scale` ist immer relativ zur Einpassgroesse. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
/** Faktor je Mausrad- oder Tastaturschritt. */
const ZOOM_STEP = 1.2;
/** Rand um das Bild, damit es im Einpasszustand nicht an der Rahmenkante klebt. */
const STAGE_PADDING = 32;

interface Size {
  width: number;
  height: number;
}

interface ZoomTransform {
  /** Multiplikator der Einpassgroesse: 1 = passt, 2 = doppelt so gross. */
  scale: number;
  /** Versatz in Pixeln relativ zur Bildmitte. */
  offsetX: number;
  offsetY: number;
}

const FIT_TRANSFORM: ZoomTransform = { scale: 1, offsetX: 0, offsetY: 0 };

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * Zoomt an der Cursorposition statt um die Bildmitte: der Punkt unter dem
 * Zeiger bleibt unter dem Zeiger. Ohne diese Umrechnung springt das Bild bei
 * jedem Rad-Schritt in eine andere Ecke, und wer gerade ein Detail sucht,
 * verliert es.
 */
function zoomAroundPointer(current: ZoomTransform, factor: number, pointer: { x: number; y: number } | null): ZoomTransform {
  const scale = clampZoom(current.scale * factor);
  if (scale === current.scale || pointer === null) return { ...current, scale };
  const ratio = scale / current.scale;
  return {
    scale,
    offsetX: pointer.x - (pointer.x - current.offsetX) * ratio,
    offsetY: pointer.y - (pointer.y - current.offsetY) * ratio,
  };
}

/**
 * Zentrierte Bildvorschau als Overlay mit Zoom und Panning.
 *
 * Die Bytes kommen aus derselben Route wie der DateiViewer: `type=read`
 * liefert fuer Bilder die rohen Bytes mit Bild-MIME (`type=preview` ist der
 * DOCX-HTML-Zweig und lehnt Bilder mit 400 ab), damit beide Anzeigen
 * dieselben Allowlist-Grenzen und Groessenlimits sehen. Zoom ist reiner
 * Darstellungszustand und lebt deshalb hier statt im DateiViewer.
 */
export function FileImagePreview({
  open,
  filePath,
  fileName,
  onClose,
  onNext,
  onPrev,
  currentIndex,
  total,
}: FileImagePreviewProps) {
  const { t } = useI18n();
  /**
   * Alles, was zu einem konkreten Bild gehoert, liegt in einem einzigen
   * `imageKey`-Schlüssel gebuendelt. Beim Wechsel von `filePath` (oder nach
   * einem Ladeversuch) faellt der Zustand ohne Effekt auf den Anfangswert
   * zurueck, und React baut das `<img>` unter derselben `key` neu auf, sodass
   * `onLoad`/`onError` garantiert *nach* dem neuen Render greifen.
   *
   * Ein Ruecksetzen in einem `useEffect` waere hier ein Wettrennen: bei einem
   * bereits gecachten Bild feuert `load` vor dem Effekt, der Zustand bliebe auf
   * "loading" kleben und die Vorschau zeigte dauerhaft den Ladehinweis.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const imageKey = `${filePath}#${reloadKey}`;
  const [imageState, setImageState] = useState<{ key: string; load: LoadState; size: Size | null }>({
    key: "",
    load: "loading",
    size: null,
  });
  const [zoomState, setZoomState] = useState<{ key: string; transform: ZoomTransform }>({
    key: "",
    transform: FIT_TRANSFORM,
  });
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const titleId = useId();

  const loadState: LoadState = imageState.key === imageKey ? imageState.load : "loading";
  const naturalSize: Size | null = imageState.key === imageKey ? imageState.size : null;
  const transform: ZoomTransform = zoomState.key === imageKey ? zoomState.transform : FIT_TRANSFORM;

  const updateZoom = useCallback((update: (previous: ZoomTransform) => ZoomTransform) => {
    setZoomState((previous) => {
      const current = previous.key === imageKey ? previous.transform : FIT_TRANSFORM;
      return { key: imageKey, transform: update(current) };
    });
  }, [imageKey]);

  const title = fileName || getFileName(filePath);
  const showCounter = total !== undefined && total > 1 && currentIndex !== undefined;
  // Bilder werden immer neu angefragt, wenn sich die Datei oder ein Ladeversuch
  // aendert: derselbe Cache-Key wie im DateiViewer, damit eine ueberlagerte
  // Vorschau keine veraltete Version zeigt.
  const src = `/api/files/${encodeFilePathForApi(filePath)}?type=read${reloadKey > 0 ? `&v=${reloadKey}` : ""}`;

  // Ohne gemessene Buehne gibt es keine Einpassgroesse. Der Rueckfall auf 1
  // haelt die Komponente auch in einem nicht gerenderten Zustand (Test-DOM,
  // `display: none`) rechenbar, statt eine Division durch 0 zu produzieren.
  // Eine gemeldete Originalbreite oder -hoehe von 0 (defektes Bild, oder
  // natuerliche Masse noch nicht verfuegbar) darf den Faktor nicht auf 0
  // ziehen — sonst waere jedes spaetere Zoom ein Vielfaches von 0.
  const fitScale = useMemo(() => {
    if (!naturalSize || !stageSize) return 1;
    const availableWidth = stageSize.width - STAGE_PADDING * 2;
    const availableHeight = stageSize.height - STAGE_PADDING * 2;
    if (availableWidth <= 0 || availableHeight <= 0) return 1;
    if (!(naturalSize.width > 0) || !(naturalSize.height > 0)) return 1;
    // Grosse Bilder werden verkleinert, kleine nicht vergroessert: "Einpassen"
    // soll ein 40x40-Pixel-Favicon nicht auf Panelbreite hochziehen.
    return Math.min(availableWidth / naturalSize.width, availableHeight / naturalSize.height, 1);
  }, [naturalSize, stageSize]);

  /** Zoomfaktor, bei dem das Bild genau in Originalpixeln gezeichnet wird. */
  const nativeZoom = clampZoom(1 / fitScale);

  /**
   * Haelt das Bild im Rahmen: solange es kleiner als der Rahmen ist, bleibt
   * der Versatz bei 0 (es ist ohnehin zentriert), sonst ist er auf den
   * Ueberhang begrenzt, damit kein Teil des Bildes unerreichbar wird.
   */
  const normalize = useCallback((value: ZoomTransform): ZoomTransform => {
    const scale = clampZoom(value.scale);
    if (!naturalSize || !stageSize) return { scale, offsetX: value.offsetX, offsetY: value.offsetY };
    const renderScale = fitScale * scale;
    const maxX = Math.max(0, (naturalSize.width * renderScale - (stageSize.width - STAGE_PADDING * 2)) / 2);
    const maxY = Math.max(0, (naturalSize.height * renderScale - (stageSize.height - STAGE_PADDING * 2)) / 2);
    return {
      scale,
      offsetX: Math.min(maxX, Math.max(-maxX, value.offsetX)),
      offsetY: Math.min(maxY, Math.max(-maxY, value.offsetY)),
    };
  }, [fitScale, naturalSize, stageSize]);

  const applyZoom = useCallback((factor: number, pointer: { x: number; y: number } | null = null) => {
    updateZoom((previous) => normalize(zoomAroundPointer(previous, factor, pointer)));
  }, [normalize, updateZoom]);

  const fitToWindow = useCallback(() => {
    updateZoom(() => normalize(FIT_TRANSFORM));
  }, [normalize, updateZoom]);

  /** Schaltet zwischen Einpassen und 100 % — die Doppelklick-Geste. */
  const toggleNativeSize = useCallback(() => {
    updateZoom((previous) => {
      const atNative = Math.abs(previous.scale - nativeZoom) < 0.001;
      return normalize(atNative ? FIT_TRANSFORM : { scale: nativeZoom, offsetX: 0, offsetY: 0 });
    });
  }, [nativeZoom, normalize, updateZoom]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((observations) => {
      const box = observations[0]?.contentRect;
      if (!box) return;
      setStageSize({ width: box.width, height: box.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    panelRef.current?.focus();
  }, [open]);

  /**
   * Ein aus dem Browsercache bedientes Bild feuert `load`, bevor React den
   * `onLoad`-Handler angehaengt hat — das `load`-Ereignis geht dann verloren,
   * und die Vorschau bliebe dauerhaft im Ladezustand. `complete` sagt genau das
   * aus, was das Ereignis gesagt haette, und schliesst damit die Luecke.
   */
  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete) return;
    if (image.naturalWidth === 0) {
      setImageState({ key: imageKey, load: "error", size: null });
      return;
    }
    setImageState({
      key: imageKey,
      load: "loaded",
      size: { width: image.naturalWidth, height: image.naturalHeight },
    });
  }, [imageKey, src]);

  // Rad-Zoom laeuft ueber einen nativen Listener: `onWheel` haengt React
  // passiv am Root und `preventDefault()` darin waere wirkungslos, sodass die
  // Seite beim Zoomen mitgescrollt wuerde.
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      const image = stage.querySelector("img");
      const imageBox = image?.getBoundingClientRect();
      const centerX = imageBox ? imageBox.left + imageBox.width / 2 : box.left + box.width / 2;
      const centerY = imageBox ? imageBox.top + imageBox.height / 2 : box.top + box.height / 2;
      applyZoom(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
        x: event.clientX - centerX,
        y: event.clientY - centerY,
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyZoom, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Nicht in fremde Eingabefelder eingreifen, falls das Panel eingebettet
      // neben einem Formular steht.
      if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyZoom(ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        applyZoom(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        fitToWindow();
      } else if (event.key === "ArrowRight" && onNext) {
        event.preventDefault();
        onNext();
      } else if (event.key === "ArrowLeft" && onPrev) {
        event.preventDefault();
        onPrev();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [applyZoom, fitToWindow, onClose, onNext, onPrev, open]);

  if (!open) return null;

  const renderScale = fitScale * transform.scale;
  const zoomPercent = Math.round(transform.scale * 100);
  const canPan = transform.scale > 1;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Unterhalb der Einpassgroesse waere die Bewegung sinnlos und wuerde das
    // Bild aus dem Rahmen schieben.
    if (!canPan || event.button !== 0) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.offsetX,
      originY: transform.offsetY,
    };
    // Pointer-Capture haelt die Bewegung auch dann am Bild, wenn der Zeiger
    // ueber den Rand der Buehne wandert. Wo die API fehlt, laeuft das Ziehen
    // trotzdem — nur ohne Ueberlauf-Fortsetzung.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    updateZoom((previous) => normalize({
      ...previous,
      offsetX: drag.originX + (event.clientX - drag.startX),
      offsetY: drag.originY + (event.clientY - drag.startY),
    }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === "function"
      && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className={`omp-modal-backdrop ${styles.backdrop}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`omp-modal-panel ${styles.panel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <span id={titleId} className={styles.title} title={filePath}>{title}</span>
          {showCounter && (
            <span className={styles.counter}>
              {t("fileImagePreview.counter", { index: currentIndex, total })}
            </span>
          )}
          <div className={styles.headerActions}>
            {onPrev && (
              <button
                type="button"
                className={`omp-press ${styles.iconButton}`}
                onClick={onPrev}
                title={t("fileImagePreview.previousImage")}
                aria-label={t("fileImagePreview.previousImage")}
              >
                <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
            )}
            {onNext && (
              <button
                type="button"
                className={`omp-press ${styles.iconButton}`}
                onClick={onNext}
                title={t("fileImagePreview.nextImage")}
                aria-label={t("fileImagePreview.nextImage")}
              >
                <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={`omp-press ${styles.iconButton}`}
              onClick={onClose}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
            >
              <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div
          ref={stageRef}
          className={`${styles.stage} ${canPan ? styles.stagePannable : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={toggleNativeSize}
        >
          {loadState !== "error" && (
            <div
              className={styles.imageFrame}
              style={{ transform: `translate(-50%, -50%) translate(${transform.offsetX}px, ${transform.offsetY}px)` }}
            >
              {/* `omp-pop-in` sitzt auf dem Bild, nicht auf der Zoom-Huelle:
                  die Animation faehrt `transform` und wuerde den Zoom-Versatz
                  im `both`-Fill ueberschreiben. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={imageKey}
                ref={imageRef}
                className={`omp-pop-in ${styles.image}`}
                src={src}
                alt={title}
                draggable={false}
                data-loaded={loadState === "loaded" ? "true" : "false"}
                style={naturalSize ? {
                  width: naturalSize.width * renderScale,
                  height: naturalSize.height * renderScale,
                } : undefined}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const measured = { width: image.naturalWidth, height: image.naturalHeight };
                  // Manche SVG- und Sonderformate melden 0x0; die CSS-`max-*`
                  // uebernehmen dann die Darstellung, statt `width: NaN` zu
                  // erzeugen.
                  setImageState({
                    key: imageKey,
                    load: "loaded",
                    size: measured.width > 0 && measured.height > 0 ? measured : null,
                  });
                }}
                onError={() => setImageState({ key: imageKey, load: "error", size: null })}
              />
            </div>
          )}
          {loadState === "loading" && <div className={styles.state}>{t("fileImagePreview.loading")}</div>}
          {loadState === "error" && (
            <div className={`${styles.state} ${styles.stateError}`} role="alert">
              <span>{t("fileImagePreview.loadFailed")}</span>
              <button
                type="button"
                className={`omp-press ${styles.retryButton}`}
                onClick={() => setReloadKey((key) => key + 1)}
              >
                {t("i18n.refresh")}
              </button>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={`omp-press ${styles.toolButton}`}
            onClick={() => applyZoom(1 / ZOOM_STEP)}
            disabled={transform.scale <= MIN_ZOOM}
            title={t("fileImagePreview.zoomOut")}
            aria-label={t("fileImagePreview.zoomOut")}
          >
            <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
          </button>
          <span className={styles.zoomReadout} aria-live="polite">
            {zoomPercent}%
          </span>
          <button
            type="button"
            className={`omp-press ${styles.toolButton}`}
            onClick={() => applyZoom(ZOOM_STEP)}
            disabled={transform.scale >= MAX_ZOOM}
            title={t("fileImagePreview.zoomIn")}
            aria-label={t("fileImagePreview.zoomIn")}
          >
            <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button
            type="button"
            className={`omp-press ${styles.toolButton}`}
            onClick={fitToWindow}
            disabled={transform.scale === 1 && transform.offsetX === 0 && transform.offsetY === 0}
            title={t("fileImagePreview.zoomFit")}
          >
            {t("fileImagePreview.fit")}
          </button>
          <button
            type="button"
            className={`omp-press ${styles.toolButton}`}
            onClick={toggleNativeSize}
            title={t("fileImagePreview.zoomActual")}
          >
            100%
          </button>
        </div>
      </div>
    </div>
  );
}
