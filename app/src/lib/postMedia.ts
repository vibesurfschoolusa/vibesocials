import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "./blobUrl";
import { parsePostMediaFields } from "./mediaInput";

/**
 * Pure rules for the `media` list of `POST /api/posts` (several photos in one
 * post). No database: shared by the route and, later, the composer.
 */

/** Most files one post may carry. */
export const MAX_POST_MEDIA = 10;

/**
 * Image types a post with two or more files may contain. No video and no GIF:
 * a carousel is photos only. A single GIF or video post is unaffected.
 */
export const MULTI_PHOTO_MIME_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/** One cleaned entry, in the shape the create helper stores as a `MediaItem`. */
export interface PostMediaEntry {
  /** The canonical blob URL (canonicalBlobUrl), as `MediaItem.storageLocation`. */
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export type PostMediaListResult =
  | { ok: true; value: PostMediaEntry[] }
  | { ok: false; error: string };

function validateEntry(raw: unknown): { ok: true; value: PostMediaEntry } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Each media entry must be an object." };
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.blobUrl !== "string" || entry.blobUrl.trim().length === 0) {
    return { ok: false, error: "blobUrl is required." };
  }
  const storageLocation = canonicalBlobUrl(entry.blobUrl);
  if (!storageLocation) {
    return { ok: false, error: BLOB_URL_REJECTED_MESSAGE };
  }
  const fields = parsePostMediaFields(entry);
  if (!fields.ok) return fields;
  return {
    ok: true,
    value: {
      storageLocation,
      originalFilename: fields.value.filename,
      mimeType: fields.value.mimeType,
      sizeBytes: fields.value.sizeBytes,
    },
  };
}

/**
 * Validate the request's `media` list. One entry gets exactly the checks a
 * single `blobUrl` gets (any image or video, GIF included). Two to
 * {@link MAX_POST_MEDIA} entries must all be {@link MULTI_PHOTO_MIME_TYPES}.
 * Returns the cleaned list in the given order, or one sentence naming the
 * broken rule (prefixed with the file's position when several were sent).
 */
export function validatePostMediaList(entries: unknown): PostMediaListResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: `media must be a list of 1 to ${MAX_POST_MEDIA} files.` };
  }
  if (entries.length > MAX_POST_MEDIA) {
    return { ok: false, error: `A post can have at most ${MAX_POST_MEDIA} photos.` };
  }

  const several = entries.length > 1;
  const cleaned: PostMediaEntry[] = [];
  for (const [index, raw] of entries.entries()) {
    const result = validateEntry(raw);
    if (!result.ok) {
      return { ok: false, error: several ? `File ${index + 1}: ${result.error}` : result.error };
    }
    cleaned.push(result.value);
  }

  if (several) {
    // The type rules are checked after every entry is well-formed, so the
    // message is about the rule, not about a malformed file.
    if (cleaned.some((m) => m.mimeType.startsWith("video/"))) {
      return {
        ok: false,
        error: "A post with several files can only contain photos. Post a video on its own.",
      };
    }
    if (cleaned.some((m) => m.mimeType === "image/gif")) {
      return {
        ok: false,
        error: "A post with several photos can't include a GIF. Post a GIF on its own.",
      };
    }
    if (cleaned.some((m) => !MULTI_PHOTO_MIME_TYPES.includes(m.mimeType))) {
      return { ok: false, error: "A post with several photos takes JPEG, PNG or WebP images only." };
    }
  }

  return { ok: true, value: cleaned };
}
