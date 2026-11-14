import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "@/lib/blobUrl";

import { validateCoverFrameTime, validateCoverImageFile, type PostCover } from "./videoCover";

export type CoverFieldResult = { ok: true; value: PostCover | null } | { ok: false; error: string };

/**
 * The `cover` field of POST /api/posts: `{ timeMs?, imageUrl?, mimeType?, sizeBytes? }`.
 * `mimeType` is the post's file type, or null on the reuse path, where it is
 * not known here (the platform clients only apply a cover to a video).
 * The image's type and size are the client's word, as they are for the post's
 * own file; the app's own storage address is checked here.
 */
export function parseCoverField(raw: unknown, mimeType: string | null): CoverFieldResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The cover could not be read." };
  if (mimeType !== null && !mimeType.startsWith("video/")) {
    return { ok: false, error: "A cover can only be chosen for a video." };
  }
  const field = raw as Record<string, unknown>;
  const cover: PostCover = {};

  if (field.timeMs !== undefined) {
    const timeError = typeof field.timeMs === "number" ? validateCoverFrameTime(field.timeMs, null) : "x";
    if (timeError) return { ok: false, error: "Choose a cover frame inside the video." };
    cover.timeMs = field.timeMs as number;
  }

  if (field.imageUrl !== undefined) {
    const imageError = validateCoverImageFile({
      type: typeof field.mimeType === "string" ? field.mimeType : "",
      size: typeof field.sizeBytes === "number" ? field.sizeBytes : 0,
    });
    if (imageError) return { ok: false, error: imageError };
    const url = typeof field.imageUrl === "string" ? canonicalBlobUrl(field.imageUrl) : null;
    if (!url) return { ok: false, error: BLOB_URL_REJECTED_MESSAGE };
    cover.imageUrl = url;
  }

  if (cover.timeMs === undefined && cover.imageUrl === undefined) {
    return { ok: false, error: "The cover could not be read." };
  }
  return { ok: true, value: cover };
}
