import { UPLOAD_ALLOWED_CONTENT_TYPES } from "./mediaInput";

/**
 * Prepares a picked file in the browser before it is uploaded (create post and
 * media library). Added 2026-11 after a live test:
 *
 * - iPhone photos are HEIC/HEIF. The upload route refuses them, Chrome cannot
 *   show them, the AI caption cannot read them, and most platforms reject them.
 *   They are converted to JPEG here.
 * - X and Google Business Profile refuse photos over 5 MB. A JPEG, WebP or PNG
 *   photo over {@link MAX_UPLOAD_PHOTO_BYTES} is re-encoded as a smaller JPEG
 *   (which also drops its metadata, including any GPS location).
 * - Any other type the upload route would refuse gets a clear message here,
 *   before the upload starts.
 *
 * Videos, GIFs and photos under the limit pass through untouched.
 */

/** Photos above this are re-encoded: under the 5 MB X and Google allow, with margin. */
export const MAX_UPLOAD_PHOTO_BYTES = 4_500_000;

/** Re-encoding attempts, in order: longest edge in pixels, JPEG quality. */
export const SHRINK_ATTEMPTS: ReadonlyArray<readonly [maxEdge: number, quality: number]> = [
  [4096, 0.9],
  [4096, 0.82],
  [3072, 0.85],
  [2048, 0.85],
];

/** Photo types re-encoded as JPEG when over the limit. A GIF is left alone (it may be animated). */
const SHRINKABLE_TYPES = new Set(["image/jpeg", "image/webp", "image/png"]);

/** JPEG quality for a converted HEIC photo. */
export const HEIC_JPEG_QUALITY = 0.92;

const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** True for an iPhone HEIC/HEIF photo, by type, or by extension when the browser gives no type. */
export function isHeicFile(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase();
  if (HEIC_TYPES.has(type)) return true;
  return (type === "" || type === "application/octet-stream") && /\.(heic|heif)$/i.test(file.name);
}

/** `IMG_5252.HEIC` -> `IMG_5252.jpg`. */
export function jpegFileName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "");
  return `${base || "photo"}.jpg`;
}

/** Scale (width, height) down so the longer edge is at most `maxEdge`; never up. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The message for a type the upload route would refuse. */
export function unsupportedTypeMessage(type: string): string {
  return `This file type (${type}) isn't supported. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.`;
}

export const HEIC_CONVERSION_FAILED_MESSAGE =
  "We couldn't convert this iPhone (HEIC) photo. Export it as a JPEG and try again.";

/** The browser work, injectable so the decisions above can be tested without a browser. */
export interface PrepareUploadDeps {
  convertHeicToJpeg(file: Blob, quality: number): Promise<Blob>;
  reencodeAsJpeg(file: Blob, maxEdge: number, quality: number): Promise<Blob>;
}

export async function prepareUploadFile(
  file: File,
  deps: PrepareUploadDeps = browserDeps,
): Promise<File> {
  let prepared = file;

  if (isHeicFile(file)) {
    let jpeg: Blob;
    try {
      jpeg = await deps.convertHeicToJpeg(file, HEIC_JPEG_QUALITY);
    } catch (error) {
      console.error("[prepareUploadFile] HEIC conversion failed", error);
      throw new Error(HEIC_CONVERSION_FAILED_MESSAGE);
    }
    prepared = new File([jpeg], jpegFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  }

  if (prepared.type !== "" && !UPLOAD_ALLOWED_CONTENT_TYPES.includes(prepared.type)) {
    throw new Error(unsupportedTypeMessage(prepared.type));
  }

  if (SHRINKABLE_TYPES.has(prepared.type) && prepared.size > MAX_UPLOAD_PHOTO_BYTES) {
    prepared = await shrinkPhoto(prepared, deps);
  }

  return prepared;
}

async function shrinkPhoto(file: File, deps: PrepareUploadDeps): Promise<File> {
  let smallest: Blob | null = null;
  for (const [maxEdge, quality] of SHRINK_ATTEMPTS) {
    const blob = await deps.reencodeAsJpeg(file, maxEdge, quality);
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size <= MAX_UPLOAD_PHOTO_BYTES) break;
  }
  if (!smallest || smallest.size >= file.size) return file;
  return new File([smallest], jpegFileName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
}

const browserDeps: PrepareUploadDeps = {
  async convertHeicToJpeg(file, quality) {
    // Loaded only when a HEIC photo is picked (it is about 3 MB). The /csp build
    // needs no `unsafe-eval`, so a future Content-Security-Policy cannot break it.
    const { heicTo } = await import("heic-to/csp");
    return heicTo({ blob: file, type: "image/jpeg", quality });
  },

  async reencodeAsJpeg(file, maxEdge, quality) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is not available");
      // A JPEG has no transparency: paint white under a WebP's transparent areas.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not re-encode the photo"))),
          "image/jpeg",
          quality,
        );
      });
    } finally {
      bitmap.close();
    }
  },
};
