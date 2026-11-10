import type { Platform } from "@prisma/client";

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

// --- The Create page's photo picker (07c) ---------------------------------
// The same rules as above, told to the user before anything uploads.

export const PHOTO_LIMIT_MESSAGE = `You can attach up to ${MAX_POST_MEDIA} photos.`;
export const PHOTO_VIDEO_ALONE_MESSAGE =
  "A video is posted on its own. Remove the photos first, or post the video separately.";
export const PHOTO_GIF_ALONE_MESSAGE = "A GIF is posted on its own.";
export const PHOTO_TYPE_MESSAGE = "A post with several photos takes JPEG, PNG or WebP images only.";

/**
 * Why a pick of several photos (or photos added to ones already attached)
 * can't be attached, or null. A video or GIF is named before the count so the
 * user learns the rule that matters. Run it again after `prepareUploadFile`:
 * an iPhone HEIC photo only counts as a JPEG once converted.
 */
export function photoPickProblem(attachedCount: number, picked: readonly { type: string }[]): string | null {
  if (picked.some((file) => file.type.startsWith("video/"))) return PHOTO_VIDEO_ALONE_MESSAGE;
  if (picked.some((file) => file.type === "image/gif")) return PHOTO_GIF_ALONE_MESSAGE;
  if (attachedCount + picked.length > MAX_POST_MEDIA) return PHOTO_LIMIT_MESSAGE;
  if (picked.some((file) => !MULTI_PHOTO_MIME_TYPES.includes(file.type))) return PHOTO_TYPE_MESSAGE;
  return null;
}

export function addPhotos<T>(list: readonly T[], added: readonly T[]): T[] {
  return [...list, ...added];
}

/** The list without that photo; the same list when the key is unknown. */
export function removePhoto<T extends { key: string }>(list: T[], key: string): T[] {
  return list.some((photo) => photo.key === key) ? list.filter((photo) => photo.key !== key) : list;
}

/** Swap the photo with its neighbour; the same list when it can't move that way. */
export function movePhoto<T extends { key: string }>(list: T[], key: string, direction: -1 | 1): T[] {
  const from = list.findIndex((photo) => photo.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** X takes at most this many photos in one post; the rest are left out. */
export const X_MAX_PHOTOS = 4;

/**
 * One short note per selected platform that will not post every attached
 * photo. Google Business Profile and Pinterest take the first photo only.
 */
export function multiPhotoPlatformNotes(
  platforms: readonly Platform[],
  photoCount: number,
): { platform: Platform; text: string }[] {
  if (photoCount < 2) return [];
  const notes: { platform: Platform; text: string }[] = [];
  for (const platform of platforms) {
    if (platform === "x" && photoCount > X_MAX_PHOTOS) {
      notes.push({ platform, text: `X shows the first ${X_MAX_PHOTOS} photos.` });
    } else if (platform === "google_business_profile") {
      notes.push({ platform, text: "Google shows the first photo." });
    } else if (platform === "pinterest") {
      notes.push({ platform, text: "Pinterest shows the first photo." });
    }
  }
  return notes;
}
