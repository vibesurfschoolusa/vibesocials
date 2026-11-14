/**
 * A video's cover (V1, 2026-11-14): a frame of the video or an uploaded image.
 * Client-safe: the Create form and the server both use these.
 *
 * Stored on the post (PostJob.coverTimeMs / coverImageUrl). No cover = each
 * platform picks its own, as before.
 *
 * - `timeMs` alone: a frame the browser could not capture as an image. Only
 *   Instagram can use it (`thumb_offset`).
 * - `timeMs` + `imageUrl`: a frame, and its JPEG captured in the browser.
 *   Instagram uses `thumb_offset`; YouTube, Facebook and LinkedIn upload the image.
 * - `imageUrl` alone: an uploaded image. Every platform uploads or links it.
 */
export interface PostCover {
  timeMs?: number;
  imageUrl?: string;
}

/**
 * The strictest cover image rule of the platforms (checked 2026-11-14):
 * Instagram's Reels `cover_url` takes JPEG only, 8 MB at most (IG User Media
 * reference); YouTube thumbnails.set takes JPEG or PNG up to 50 MB; Facebook's
 * video thumbnails 10 MB; LinkedIn's Videos API names no limit.
 */
export const COVER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const COVER_IMAGE_TYPES: readonly string[] = ["image/jpeg"];
export const COVER_IMAGE_RULE = "The cover must be a JPEG image of 8 MB or less.";

/** No video the platforms take is longer than this (TikTok and YouTube allow hours; this bounds bad input). */
export const COVER_MAX_TIME_MS = 12 * 60 * 60 * 1000;

const FRAME_TIME_ERROR = "Choose a cover frame inside the video.";

export function validateCoverImageFile(file: { type: string; size: number }): string | null {
  if (!COVER_IMAGE_TYPES.includes(file.type)) return COVER_IMAGE_RULE;
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > COVER_IMAGE_MAX_BYTES) return COVER_IMAGE_RULE;
  return null;
}

/** `durationMs` null: the length is not known here (the server), so only the shape is checked. */
export function validateCoverFrameTime(timeMs: number, durationMs: number | null): string | null {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > COVER_MAX_TIME_MS) return FRAME_TIME_ERROR;
  if (durationMs !== null && timeMs > durationMs) return FRAME_TIME_ERROR;
  return null;
}

/** The PostJob columns for a cover; none for no cover, so a post without one writes today's row. */
export function coverJobColumns(cover: PostCover | null | undefined): { coverTimeMs?: number; coverImageUrl?: string } {
  if (!cover) return {};
  return {
    ...(cover.timeMs !== undefined ? { coverTimeMs: cover.timeMs } : {}),
    ...(cover.imageUrl ? { coverImageUrl: cover.imageUrl } : {}),
  };
}

/** The cover a job row holds, or undefined. A row read without the columns has none. */
export function coverFromJob(job: { coverTimeMs?: number | null; coverImageUrl?: string | null }): PostCover | undefined {
  const hasTime = typeof job.coverTimeMs === "number";
  const hasImage = typeof job.coverImageUrl === "string" && job.coverImageUrl !== "";
  if (!hasTime && !hasImage) return undefined;
  return {
    ...(hasTime ? { timeMs: job.coverTimeMs as number } : {}),
    ...(hasImage ? { imageUrl: job.coverImageUrl as string } : {}),
  };
}

// ---- The Create form's cover state ----

export type CoverChoice =
  | { kind: "default" }
  | { kind: "frame"; timeMs: number }
  | { kind: "upload"; file: File };

export interface UploadedCoverImage {
  url: string;
  mimeType: string;
  sizeBytes: number;
}

/** The slider's value as a whole millisecond inside the video (0 while the length is unknown). */
export function clampCoverTimeMs(timeMs: number, durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const max = Math.floor(durationSec * 1000);
  return Math.min(max, Math.max(0, Math.round(timeMs)));
}

/** `m:ss.t`, the chosen frame's place in the video. */
export function formatCoverTime(timeMs: number): string {
  const tenths = Math.floor(Math.max(0, timeMs) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/**
 * The `cover` field of POST /api/posts for a choice and the image uploaded for
 * it (the captured frame, or the chosen file). Nothing for the platform
 * default, and nothing for an upload whose image did not upload.
 */
export function coverRequestFields(
  choice: CoverChoice,
  image: UploadedCoverImage | null,
): { cover?: { timeMs?: number; imageUrl?: string; mimeType?: string; sizeBytes?: number } } {
  const imageFields = image ? { imageUrl: image.url, mimeType: image.mimeType, sizeBytes: image.sizeBytes } : {};
  if (choice.kind === "frame") return { cover: { timeMs: choice.timeMs, ...imageFields } };
  if (choice.kind === "upload" && image) return { cover: imageFields };
  return {};
}
