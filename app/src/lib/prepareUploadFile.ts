import { extensionOf, withoutExtension } from "./fileExtension";
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
 * - A file the browser gave no type takes the one its name tells (uploadTypeOf).
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

/** `IMG_5252.HEIC` -> `IMG_5252.jpg`; only a real extension is swapped, so "St. Lucia sunset" keeps its name. */
export function jpegFileName(name: string): string {
  const base = withoutExtension(name);
  return `${base || "photo"}.jpg`;
}

/** Scale (width, height) down so the longer edge is at most `maxEdge`; never up. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const CANT_TELL = "We couldn't tell what kind of file this is.";
const ANY_TYPE_STEP = "Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.";

/** What a file whose type can't be told is told (R45 client-journey L1: never "type ()"). */
export const UNKNOWN_TYPE_MESSAGE = `${CANT_TELL} ${ANY_TYPE_STEP}`;

/**
 * Where a file whose type can't be told was picked, so the step names a
 * control that screen has. "choose": Create's single pick, Add many and the
 * Media library. "sendMore" (R47 client-journey L1): /u, where the picker is
 * gone once the files were tried and Send more brings it back. "photoPick"
 * (R47 client-journey L3): Create's pick of several photos, where the file
 * must be named and a GIF or a video would be refused anyway.
 */
export type UnknownTypeContext = "choose" | "sendMore" | "photoPick";

/**
 * R46 review: the one sentence for a file whose type can't be told (no browser
 * type and no known extension), wherever it is checked. R46 client-journey L2:
 * a name with no extension (a photo saved as "IMG_0042", or "Surf day
 * 19.11.2026", whose dot starts none) gets the step that works, since choosing
 * it again fails the same way. A name with some other extension gets no rename
 * step: adding .mp4 to a .mkv would not make it one.
 */
export function unknownTypeMessage(name: string, context: UnknownTypeContext = "choose"): string {
  const hasExtension = extensionOf(name) !== undefined;
  if (context === "photoPick") {
    const lead = `${name}: we couldn't tell what kind of file this is.`;
    return hasExtension
      ? `${lead} Use a JPEG, PNG or WebP photo.`
      : `${lead} If it's a photo, add .jpg to the end of its name, then choose the photos again.`;
  }
  if (hasExtension) return UNKNOWN_TYPE_MESSAGE;
  const again = context === "sendMore" ? "then press Send more and choose it again" : "then choose it again";
  return `${CANT_TELL} If it's a photo or video, add .jpg or .mp4 to the end of its name, ${again}. ${ANY_TYPE_STEP}`;
}

/** The sentence a typeless file whose name has no extension gets where it is chosen again. */
export const NO_EXTENSION_MESSAGE = unknownTypeMessage("IMG_0042");

/** The message for a type the upload route would refuse; "" is a type that can't be told. */
export function unsupportedTypeMessage(type: string): string {
  if (type.trim() === "") return UNKNOWN_TYPE_MESSAGE;
  return `This file type (${type}) isn't supported. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.`;
}

/** The uploadable types by file extension, for a file the browser gave no type. */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/**
 * The type `file` is uploaded as: its own, or, when the browser gave none (some
 * phones give a video or an extensionless photo no type), the one its name's
 * extension tells. "" when that can't be told either.
 */
export function uploadTypeOf(file: { name: string; type: string }): string {
  if (file.type !== "" && file.type !== "application/octet-stream") return file.type;
  const extension = extensionOf(file.name);
  return extension !== undefined && Object.hasOwn(TYPE_BY_EXTENSION, extension) ? TYPE_BY_EXTENSION[extension] : "";
}

export const HEIC_CONVERSION_FAILED_MESSAGE =
  "We couldn't convert this iPhone (HEIC) photo. Export it as a JPEG and try again.";

/**
 * The type `file` will have once prepareUploadFile is done, decided the same
 * way without doing the work: a HEIC becomes a JPEG, a JPEG, WebP or PNG over
 * {@link MAX_UPLOAD_PHOTO_BYTES} is re-encoded as one, anything else keeps its
 * type. The Create page judges a photo still being prepared by it (R22 M1).
 */
export function preparedTypeOf(file: { name: string; type: string; size: number }): string {
  if (isHeicFile(file)) return "image/jpeg";
  const type = uploadTypeOf(file);
  if (SHRINKABLE_TYPES.has(type) && file.size > MAX_UPLOAD_PHOTO_BYTES) return "image/jpeg";
  return type;
}

/** The browser work, injectable so the decisions above can be tested without a browser. */
export interface PrepareUploadDeps {
  convertHeicToJpeg(file: Blob, quality: number): Promise<Blob>;
  reencodeAsJpeg(file: Blob, maxEdge: number, quality: number): Promise<Blob>;
}

export async function prepareUploadFile(
  file: File,
  deps: PrepareUploadDeps = browserDeps,
  context: UnknownTypeContext = "choose",
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

  const type = uploadTypeOf(prepared);
  if (!UPLOAD_ALLOWED_CONTENT_TYPES.includes(type)) {
    throw new Error(type === "" ? unknownTypeMessage(prepared.name, context) : unsupportedTypeMessage(type));
  }
  if (type !== prepared.type) {
    prepared = new File([prepared], prepared.name, { type, lastModified: prepared.lastModified });
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
