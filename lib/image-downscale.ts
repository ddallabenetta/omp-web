import {
  ATTACHED_IMAGE_LONGEST_SIDE,
  ATTACHED_IMAGE_MAX_BYTES,
  getBase64DecodedByteLength,
} from "./image-attachments";

/**
 * Client-side downscale for chat attachments.
 *
 * The browser reads a picked file straight into a data URL at full
 * resolution, so a single phone photo lands in the request body at its
 * original 3 MB. A message that fills `MAX_ATTACHED_IMAGES` then serializes
 * past what the transport accepts and the whole send is refused — including
 * the text, and before any route handler ever sees it.
 *
 * Downscaling in the browser is what keeps that reachable: it shrinks the
 * image for real, so the user keeps the attachment instead of watching it
 * vanish from the composer. The CLI already normalizes its own attachments
 * this way, so both surfaces send comparable payloads.
 *
 * Everything here runs in the browser and degrades to "send as-is" when the
 * platform has no canvas, which keeps the original behavior rather than
 * rejecting an attachment the user can see working elsewhere.
 */

/** JPEG quality steps tried when a full-size encode is still too large. */
const QUALITY_STEPS = [0.92, 0.85, 0.75, 0.65] as const;

/** Longest-edge steps tried when quality alone cannot reach the byte target. */
const SCALE_STEPS = [1, 0.75, 0.5, 0.35] as const;

const CANVAS_MIME = "image/jpeg";

/** The browser canvas can produce PNG, which base64 makes larger; never ship it. */
function isCanvasOutputMime(mimeType: string): boolean {
  return mimeType === CANVAS_MIME || mimeType === "image/webp";
}

/** Shortest edge kept when scaling down, so text does not become unreadable. */
const MIN_LONGEST_SIDE = 640;

export interface DownscaleOptions {
  /** Longest edge, in pixels, allowed for the result. */
  maxLongestSide?: number;
  /** Byte target for a single image. */
  maxBytes?: number;
}

/**
 * Re-encode `file` so it fits the attachment budget, down to a lower quality
 * or a smaller edge. Returns the original file untouched when it already fits
 * or when the platform cannot decode it — re-encoding an image that is
 * already small enough only loses detail.
 */
export async function downscaleImageFile(
  file: File,
  { maxLongestSide = ATTACHED_IMAGE_LONGEST_SIDE, maxBytes = ATTACHED_IMAGE_MAX_BYTES }: DownscaleOptions = {},
): Promise<File> {
  const originalBytes = file.size;
  const originalLongestSide = await readLongestSide(file);
  const fitsAlready = originalBytes <= maxBytes
    && (originalLongestSide === null || originalLongestSide <= maxLongestSide);
  if (fitsAlready || typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    for (const scale of SCALE_STEPS) {
      const targetSide = Math.max(MIN_LONGEST_SIDE, Math.round(maxLongestSide * scale));
      const { width, height } = fitWithin(bitmap.width, bitmap.height, targetSide);

      for (const quality of QUALITY_STEPS) {
        const encoded = await encodeToFile(bitmap, width, height, quality, file.name);
        if (!encoded) return file;
        if (encoded.size <= maxBytes) return encoded;
      }
    }
    // Nothing reached the byte target: keep the original rather than ship a
    // picture that lost detail for nothing.
    return file;
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

/** Decode dimensions without keeping the pixels around; null when unreadable. */
async function readLongestSide(file: File): Promise<number | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    bitmap.close();
    return longest;
  } catch {
    return null;
  }
}

/** Largest `maxSide`-bounded box with the source aspect ratio. */
function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encodeToFile(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
  originalName: string,
): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, quality);
  if (!blob || !isCanvasOutputMime(blob.type)) return null;
  return new File([blob], renameToJpeg(originalName), { type: blob.type });
}

/** `canvas.toBlob` as a promise, falling back to the data-URL encoder. */
function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  if (typeof canvas.toBlob !== "function") {
    resolve(readBlobFromDataUrl(canvas, quality));
    return promise;
  }
  canvas.toBlob(
    (blob) => resolve(blob ?? readBlobFromDataUrl(canvas, quality)),
    CANVAS_MIME,
    quality,
  );
  return promise;
}

function readBlobFromDataUrl(canvas: HTMLCanvasElement, quality: number): Blob | null {
  const dataUrl = canvas.toDataURL(CANVAS_MIME, quality);
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: CANVAS_MIME });
}

/**
 * Keep the name recognizable while giving the new bytes an honest extension,
 * so a later save does not write JPEG data under a `.png` name.
 */
function renameToJpeg(name: string): string {
  const base = name.replace(/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i, "");
  return `${base || "image"}.jpg`;
}

/**
 * Bytes `data` occupies inside a JSON request body. Base64 plus the JSON
 * string quoting around it, which the transport counts too.
 */
export function estimateWireBytes(data: string): number {
  const decoded = getBase64DecodedByteLength(data);
  if (decoded === null) return 0;
  return Math.ceil(decoded / 3) * 4;
}