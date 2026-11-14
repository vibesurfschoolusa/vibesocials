/**
 * Shared validation for client-supplied media metadata (`POST /api/media` and
 * the blobUrl path of `POST /api/posts`). Both routes write a `MediaItem` row
 * from these fields, so they must apply the same rules.
 */

/** Largest single file accepted — matches the upload route's `maximumSizeInBytes`. */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

/**
 * The content types the blob upload token allows (`POST /api/upload`). The
 * browser checks a file against this list before uploading
 * (lib/prepareUploadFile.ts), so an unsupported type gets a clear message
 * instead of the blob store's generic refusal. iPhone HEIC/HEIF photos are not
 * on it: the browser converts them to JPEG first.
 */
export const UPLOAD_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

/** Longest `originalFilename` accepted (the usual filesystem name limit). */
export const FILENAME_MAX_LENGTH = 255;

/**
 * The image/video rule `POST /api/media` has always applied: a plain,
 * case-sensitive prefix check on the MIME type. Anything else (including a
 * missing or non-string value) is not postable media.
 */
export function isImageOrVideoMimeType(value: unknown): value is string {
  return (
    typeof value === "string" && (value.startsWith("image/") || value.startsWith("video/"))
  );
}

export interface PostMediaFields {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export type PostMediaFieldsResult =
  | { ok: true; value: PostMediaFields }
  | { ok: false; error: string };

/**
 * Validates the media fields of a create-post body that supplies a `blobUrl`
 * (so a new `MediaItem` is created from them):
 *
 * - `mimeType` — REQUIRED, must be `image/*` or `video/*` (`isImageOrVideoMimeType`).
 * - `sizeBytes` — optional; when present a non-negative safe integer no larger
 *   than {@link MAX_MEDIA_BYTES} (the column is a 32-bit Int, so a larger value
 *   would otherwise surface as a 500). Absent / null -> 0.
 * - `filename` — optional string of at most {@link FILENAME_MAX_LENGTH}
 *   characters. Absent / null / empty -> "upload".
 */
export function parsePostMediaFields(raw: {
  filename?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}): PostMediaFieldsResult {
  if (!isImageOrVideoMimeType(raw.mimeType)) {
    return { ok: false, error: "mimeType must be an image/* or video/* type." };
  }

  let sizeBytes = 0;
  if (raw.sizeBytes != null) {
    if (
      typeof raw.sizeBytes !== "number" ||
      !Number.isSafeInteger(raw.sizeBytes) ||
      raw.sizeBytes < 0 ||
      raw.sizeBytes > MAX_MEDIA_BYTES
    ) {
      return {
        ok: false,
        error: "sizeBytes must be a non-negative whole number (max 512 MB).",
      };
    }
    sizeBytes = raw.sizeBytes;
  }

  let filename = "upload";
  if (raw.filename != null) {
    if (typeof raw.filename !== "string" || raw.filename.length > FILENAME_MAX_LENGTH) {
      return {
        ok: false,
        error: `filename must be a string of at most ${FILENAME_MAX_LENGTH} characters.`,
      };
    }
    filename = raw.filename || "upload";
  }

  return { ok: true, value: { filename, mimeType: raw.mimeType, sizeBytes } };
}

// --- What storage itself says about a file (F5) ------------------------------
// The size counts against the workspace's storage limit, so it is read from the
// blob store (`head`), never taken from the request. `head` is passed in: this
// file is also read by browser code (lib/prepareUploadFile.ts), which must not
// pull in the server storage SDK.

/** The part of `head()`'s answer read here. */
export type StoredFileHead = (url: string) => Promise<{ size: number; contentType: string }>;

export const STORED_FILE_UNREADABLE_MESSAGE = "Couldn't find this file in storage. Upload it again.";

export type StoredMediaResult =
  | { ok: true; value: { sizeBytes: number; mimeType: string } }
  | { ok: false; error: string };

/**
 * The stored file's size and type, or one sentence: no such file (or storage
 * could not answer), a type uploads do not allow (UPLOAD_ALLOWED_CONTENT_TYPES),
 * empty, or over 512 MB.
 */
export async function readStoredMedia(blobUrl: string, head: StoredFileHead): Promise<StoredMediaResult> {
  let stored: { size: number; contentType: string };
  try {
    stored = await head(blobUrl);
  } catch {
    return { ok: false, error: STORED_FILE_UNREADABLE_MESSAGE };
  }
  if (!UPLOAD_ALLOWED_CONTENT_TYPES.includes(stored.contentType)) {
    return { ok: false, error: "Only photos and videos can be added." };
  }
  if (!Number.isSafeInteger(stored.size) || stored.size <= 0) {
    return { ok: false, error: "This file is empty. Upload it again." };
  }
  if (stored.size > MAX_MEDIA_BYTES) {
    return { ok: false, error: "File is too large (max 512 MB)." };
  }
  return { ok: true, value: { sizeBytes: stored.size, mimeType: stored.contentType } };
}

/**
 * A request's file entry (`blobUrl`, `mimeType`, `sizeBytes`, ...) with the
 * stored size and type in place of the ones it named. Storage is the truth:
 * a browser that called a JPEG "image/jpg" is not refused, and the usual checks
 * then run on the stored type. `url` is the entry's canonical address; without
 * one the entry is returned as it is, and those checks refuse it.
 */
export async function withStoredMediaFacts(
  raw: Record<string, unknown>,
  url: string | null,
  head: StoredFileHead,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  if (!url) return { ok: true, value: raw };
  const stored = await readStoredMedia(url, head);
  if (!stored.ok) return stored;
  return { ok: true, value: { ...raw, mimeType: stored.value.mimeType, sizeBytes: stored.value.sizeBytes } };
}
