/**
 * Shared validation for client-supplied media metadata (`POST /api/media` and
 * the blobUrl path of `POST /api/posts`). Both routes write a `MediaItem` row
 * from these fields, so they must apply the same rules.
 */

/** Largest single file accepted — matches the upload route's `maximumSizeInBytes`. */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

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
