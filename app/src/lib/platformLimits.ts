import type { Platform } from "@prisma/client";

/**
 * Roadmap Phase 7 (spec §7.1) — single source of truth for each platform's
 * CLIENT-ENFORCED caption length limit.
 *
 * `charLimit: number` means the corresponding client in `server/platforms/`
 * truncates the caption to that many extended grapheme clusters (via
 * `truncateGraphemes`, see `lib/truncate.ts`) before posting. `charLimit: null`
 * means that client does NOT truncate today — whatever caption is built is
 * sent as-is (the platform's own API may enforce its own limit server-side,
 * but nothing in this codebase does it client-side).
 *
 * This map exists so the composer's live preview (`lib/platformPreview.ts`)
 * can never drift from what actually gets posted: the preview and the real
 * `xClient`/`tiktokClient` truncation both read the SAME numbers from here.
 *
 * IMPORTANT: raising a `null` to a real number here does NOT, by itself,
 * change what gets posted — it would only change what the preview *predicts*,
 * making the preview show a truncation that never actually happens. Adding
 * real truncation for a platform that doesn't have it today is a deliberate,
 * separate posting-behavior change: it requires adding a `truncateGraphemes`
 * call to that platform's client (see xClient.ts / tiktokClient.ts for the
 * pattern) in the SAME change that edits this map — never edit this map alone.
 */
export interface PlatformCaptionLimit {
  /**
   * Max caption length in extended grapheme clusters, or `null` when the
   * client sends the caption untruncated.
   */
  charLimit: number | null;
  /** Ellipsis appended on truncation. Only meaningful when `charLimit` is set. */
  ellipsis?: string;
}

export const PLATFORM_CAPTION_LIMITS: Record<Platform, PlatformCaptionLimit> = {
  // Matches the truncateGraphemes call in server/platforms/xClient.ts.
  x: { charLimit: 280, ellipsis: "..." },
  // Matches the truncateGraphemes call in server/platforms/tiktokClient.ts.
  tiktok: { charLimit: 2200 },
  // youtubeClient.ts truncates the auto-derived VIDEO TITLE (a separate field,
  // capped at 100 chars) but sends the caption/description in full — no
  // client-side limit on the caption itself today.
  youtube: { charLimit: null },
  // Matches the truncateGraphemes call in server/platforms/instagramClient.ts
  // (computeInstagramCaption). Instagram rejects a caption over 2,200
  // characters, so before the 2026-11-01 audit an over-long caption failed the
  // whole publish; the composer preview now warns and the client truncates.
  instagram: { charLimit: 2200 },
  // No client-side truncation today (server/platforms/linkedinClient.ts).
  linkedin: { charLimit: null },
  // No client-side truncation today (server/platforms/facebookPageClient.ts).
  facebook_page: { charLimit: null },
  // No client-side truncation today (server/platforms/googleBusinessProfileClient.ts,
  // which in fact doesn't send a caption/description at all yet).
  google_business_profile: { charLimit: null },
};

/**
 * The title TikTok posts when the (footer-applied) caption is empty. Shared
 * source of truth so `tiktokClient.ts`'s `computeTikTokCaption` and the
 * composer preview (`platformPreview.ts`) can't drift on it (Phase 7 review
 * Minor #1 — the preview must show what TikTok will actually post).
 */
export const TIKTOK_DEFAULT_CAPTION = "Video posted via Vibe Socials";

/** The two kinds of media a post can carry. */
export type MediaKind = "image" | "video";

/**
 * Media kinds each platform's CLIENT accepts — read from the client code, not
 * from platform documentation, so this can't claim support the publish path
 * doesn't have (2026-11-01 audit). Each entry cites where the client decides:
 *
 * - youtube        — video only: rejects a non-video with YOUTUBE_MEDIA_NOT_VIDEO
 *                    (server/platforms/youtubeClient.ts:65-75).
 * - tiktok         — video only: TIKTOK_MEDIA_NOT_VIDEO
 *                    (server/platforms/tiktokClient.ts:654-658).
 * - facebook_page  — images only: FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE
 *                    (server/platforms/facebookPageClient.ts:67-73).
 * - instagram      — both: a video becomes a REELS container, anything else an
 *                    IMAGE container (server/platforms/instagramClient.ts:126,
 *                    156-161).
 * - x              — both: rejects only what is neither (X_INVALID_MEDIA_TYPE,
 *                    server/platforms/xClient.ts:528-537).
 * - linkedin       — both: uploads a video via uploadVideo, an image via
 *                    uploadImage (server/platforms/linkedinClient.ts:619-643).
 * - google_business_profile — both: the client only logs a warning for a
 *                    non-image and sends mediaFormat "VIDEO" for it
 *                    (server/platforms/googleBusinessProfileClient.ts:41-59);
 *                    it never rejects, so neither does this map.
 */
export const PLATFORM_ACCEPTED_MEDIA: Record<Platform, readonly MediaKind[]> = {
  youtube: ["video"],
  tiktok: ["video"],
  facebook_page: ["image"],
  instagram: ["image", "video"],
  x: ["image", "video"],
  linkedin: ["image", "video"],
  google_business_profile: ["image", "video"],
};

/**
 * Classify a MIME type the way every client does — a plain, case-sensitive
 * `startsWith` on `video/` / `image/` — or `null` for anything else.
 */
export function mediaKindOf(mimeType: string): MediaKind | null {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

/**
 * Can `platform` publish media of this MIME type?
 *
 * `null` / `undefined` means "no media chosen yet" and accepts everything (there
 * is nothing to be incompatible with); any actual MIME type that is neither an
 * image nor a video — including the empty string a browser reports for an
 * unknown file — is accepted by no platform.
 */
export function platformAcceptsMedia(
  platform: Platform,
  mimeType: string | null | undefined,
): boolean {
  if (mimeType == null) return true;
  const kind = mediaKindOf(mimeType);
  return kind !== null && PLATFORM_ACCEPTED_MEDIA[platform].includes(kind);
}

/**
 * Short, user-facing reason `platform` can't publish this media (shown next to
 * a disabled platform in the composer), or `null` when it can.
 */
export function unsupportedMediaReason(
  platform: Platform,
  mimeType: string | null | undefined,
): string | null {
  if (platformAcceptsMedia(platform, mimeType)) return null;
  if (mimeType == null || mediaKindOf(mimeType) === null) return "Unsupported file type";
  return PLATFORM_ACCEPTED_MEDIA[platform].includes("video") ? "Video only" : "Images only";
}
