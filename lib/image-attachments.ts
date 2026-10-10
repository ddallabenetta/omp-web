export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHED_IMAGES = 10;

/**
 * Wire budget for one message.
 *
 * `MAX_ATTACHED_IMAGE_BYTES` bounds a single image, but the transport bounds
 * the whole request: `JSON.stringify` inlines every image as base64, which
 * inflates each byte by 4/3. Ten 10 MB attachments therefore serialize to
 * ~133 MB and are refused by the proxy before any route handler runs — the
 * per-image limit alone is not reachable. This aggregate is the limit that is
 * actually enforceable, so it is the one the transport is sized against.
 */
export const MAX_ATTACHED_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Longest edge, in pixels, that an attachment is downscaled to before it is
 * re-encoded. Matches what the CLI already applies to its own attachments, so
 * a screenshot looks the same whichever surface sent it, and a 12 MP phone
 * photo lands around 0.5 MB instead of 3 MB.
 */
export const ATTACHED_IMAGE_LONGEST_SIDE = 2048;

/**
 * Per-image target after downscaling. Chosen so that a full message of them
 * stays inside `MAX_ATTACHED_IMAGES_TOTAL_BYTES` with room to spare.
 */
export const ATTACHED_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Smallest `experimental.proxyClientMaxBodySize` that lets a message at the
 * aggregate budget reach a route handler: the base64 expansion of that budget
 * plus a margin for the JSON envelope and its fields.
 *
 * Not applied to `next.config.ts` by import — the Next config loader cannot be
 * relied on to resolve this module — so `image-attachments.test.mjs` asserts
 * the config against this value instead.
 */
export const MIN_PROXY_CLIENT_MAX_BODY_SIZE = 32 * 1024 * 1024;

/** Bytes a base64 payload of `decodedBytes` occupies on the wire. */
export function getBase64WireByteLength(decodedBytes: number): number {
  if (!Number.isFinite(decodedBytes) || decodedBytes < 0) return 0;
  return Math.ceil(decodedBytes / 3) * 4;
}

/** Sum of the decoded sizes of `images`, or 0 for a malformed entry. */
export function getTotalDecodedByteLength(
  images: ReadonlyArray<{ data: string }>,
): number {
  let total = 0;
  for (const image of images) {
    const bytes = getBase64DecodedByteLength(image?.data ?? "");
    if (bytes === null) return 0;
    total += bytes;
  }
  return total;
}

export interface Base64ImageAttachment {
  data: string;
  mimeType: string;
}

function isBase64DataChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

export function getBase64DecodedByteLength(data: string): number | null {
  if (!data || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const dataEnd = data.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64DataChar(data.charCodeAt(index))) return null;
  }
  for (let index = dataEnd; index < data.length; index += 1) {
    if (data[index] !== "=") return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function isBase64ImageWithinLimits(value: unknown): value is Base64ImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<Base64ImageAttachment>;
  if (typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
    return false;
  }
  const bytes = getBase64DecodedByteLength(image.data);
  return bytes !== null && bytes <= MAX_ATTACHED_IMAGE_BYTES;
}

/** Return an API-safe error for prompt, steering, and follow-up image arrays. */
export function validateAgentImages(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  if (value.length > MAX_ATTACHED_IMAGES) {
    return `A message can include at most ${MAX_ATTACHED_IMAGES} images`;
  }
  let totalBytes = 0;
  for (const image of value) {
    if (!image || typeof image !== "object" || (image as { type?: unknown }).type !== "image") {
      return "Each attachment must be an image";
    }
    if (!isBase64ImageWithinLimits(image)) {
      return `Each image must be valid base64 image data of ${MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or smaller`;
    }
    totalBytes += getBase64DecodedByteLength(image.data) ?? 0;
  }
  if (totalBytes > MAX_ATTACHED_IMAGES_TOTAL_BYTES) {
    return `Images in one message must total ${MAX_ATTACHED_IMAGES_TOTAL_BYTES / (1024 * 1024)}MB or less`;
  }
  return null;
}
