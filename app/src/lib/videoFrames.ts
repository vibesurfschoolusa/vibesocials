/**
 * Still frames from a video, for the AI caption (2026-11-08).
 *
 * The caption AI can see a photo, but not a video, so a video's caption used to
 * be a guess. The composer now grabs a few frames in the browser
 * (lib/extractVideoFrames.ts) and sends them as small JPEG data URLs;
 * POST /api/posts/auto-caption checks them here and hands them to the vision
 * model. Shared by both sides, and free of browser-only code.
 */

/** How many frames the composer sends, and the most the server accepts. */
export const MAX_VIDEO_FRAMES = 3;

/**
 * The longest frame data URL accepted (about 300 KB of JPEG). The composer's
 * frames are 512 px wide at quality 0.7, typically 30 to 80 KB.
 */
export const MAX_FRAME_DATA_URL_LENGTH = 400_000;

const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Where to take the frames: 20%, 50% and 80% through the clip (the start, the
 * middle and the end, skipping a fade-in or an end card), or the first frame
 * when the duration is unknown.
 */
export function videoFrameTimes(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  return [0.2, 0.5, 0.8].map((share) => Math.round(durationSec * share * 1000) / 1000);
}

/**
 * The `frames` field of an auto-caption request: absent means none; otherwise
 * at most MAX_VIDEO_FRAMES JPEG data URLs, each at most
 * MAX_FRAME_DATA_URL_LENGTH long. Anything else is "invalid". Only inline data
 * is accepted, never a URL, so nothing here is fetched by anyone.
 */
export function parseVideoFrames(value: unknown): string[] | "invalid" {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_VIDEO_FRAMES) return "invalid";
  for (const frame of value) {
    if (typeof frame !== "string") return "invalid";
    if (frame.length > MAX_FRAME_DATA_URL_LENGTH) return "invalid";
    if (!JPEG_DATA_URL.test(frame)) return "invalid";
  }
  return value as string[];
}
