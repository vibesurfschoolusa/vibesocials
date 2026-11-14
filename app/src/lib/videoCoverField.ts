import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "@/lib/blobUrl";
import { COVER_ADDRESS_REFUSED_MESSAGE, isWorkspaceCoverAddress } from "@/lib/coverBlobPath";
import type { StoredFileHead } from "@/lib/mediaInput";

import { validateCoverFrameTime, validateCoverImageFile, type PostCover } from "./videoCover";

export type CoverFieldResult = { ok: true; value: PostCover | null } | { ok: false; error: string };

/**
 * The `cover` field of POST /api/posts: `{ timeMs?, imageUrl?, mimeType?, sizeBytes? }`.
 * `mimeType` is the post's file type, or null on the reuse path, where it is
 * not known here (the platform clients only apply a cover to a video).
 * The image's type and size are the ones withStoredCoverFacts read from
 * storage (R3-security M1); the app's own storage address is checked here, and
 * (fix round 1) that it is in this workspace's covers/ folder (lib/coverBlobPath.ts).
 */
export function parseCoverField(raw: unknown, mimeType: string | null, workspaceId: string): CoverFieldResult {
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
    if (!isWorkspaceCoverAddress(url, workspaceId)) return { ok: false, error: COVER_ADDRESS_REFUSED_MESSAGE };
    cover.imageUrl = url;
  }

  if (cover.timeMs === undefined && cover.imageUrl === undefined) {
    return { ok: false, error: "The cover could not be read." };
  }
  return { ok: true, value: cover };
}

export const COVER_IMAGE_UNREADABLE_MESSAGE =
  "Couldn't find the cover image in storage. Choose the cover again and post once more.";

/**
 * R3-security M1: the `cover` field with the image's type and size read from
 * storage in place of the ones the request named, as withStoredMediaFacts does
 * for the post's own file, so a video parked under covers/ is refused by
 * parseCoverField instead of being kept as a cover. Only an address in this
 * workspace's covers/ folder is asked about; anything else is returned as it
 * is, and parseCoverField refuses it.
 */
export async function withStoredCoverFacts(
  raw: unknown,
  workspaceId: string,
  head: StoredFileHead,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: true, value: raw };
  const field = raw as Record<string, unknown>;
  const url = typeof field.imageUrl === "string" ? canonicalBlobUrl(field.imageUrl) : null;
  if (!url || !isWorkspaceCoverAddress(url, workspaceId)) return { ok: true, value: raw };
  let stored: { size: number; contentType: string };
  try {
    stored = await head(url);
  } catch {
    return { ok: false, error: COVER_IMAGE_UNREADABLE_MESSAGE };
  }
  return { ok: true, value: { ...field, mimeType: stored.contentType, sizeBytes: stored.size } };
}
