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
  // No client-side truncation today (server/platforms/instagramClient.ts).
  instagram: { charLimit: null },
  // No client-side truncation today (server/platforms/linkedinClient.ts).
  linkedin: { charLimit: null },
  // No client-side truncation today (server/platforms/facebookPageClient.ts).
  facebook_page: { charLimit: null },
  // No client-side truncation today (server/platforms/googleBusinessProfileClient.ts,
  // which in fact doesn't send a caption/description at all yet).
  google_business_profile: { charLimit: null },
};
