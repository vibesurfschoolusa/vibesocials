import type { TikTokPostMetadata } from "@/server/platforms/types";

import { TIKTOK_PRIVACY_LABELS } from "./platforms";

/**
 * The rules from TikTok's Content Sharing Guidelines that the posting screen
 * applies, as pure functions so they can be tested
 * (https://developers.tiktok.com/doc/content-sharing-guidelines). The Direct
 * Post audit was rejected in 2026 for points 3a, 3b, 4 and 5d; these pin them.
 */

/** 3b: shown on hover and inline wherever "Only me" and Branded content collide. */
export const TIKTOK_BRANDED_PRIVATE_TEXT = "Branded content visibility cannot be set to private.";

/** 3a: shown, and on the disabled Publish button, when disclosure is on with nothing ticked. */
export const TIKTOK_DISCLOSURE_INCOMPLETE_TEXT =
  "You need to indicate if your content promotes yourself, a third party, or both.";

/**
 * 3a: the label TikTok will put on the video. Branded content (alone or with
 * Your brand) is "Paid partnership"; Your brand alone is "Promotional content".
 */
export function tiktokDisclosureLabel(
  metadata: Pick<TikTokPostMetadata, "brandedContent" | "brandOrganic">,
): "Paid partnership" | "Promotional content" | null {
  if (metadata.brandedContent) return "Paid partnership";
  if (metadata.brandOrganic) return "Promotional content";
  return null;
}

/** A privacy option as the user reads it; an option TikTok adds later shows as sent. */
export function tiktokPrivacyLabel(option: string): string {
  return TIKTOK_PRIVACY_LABELS[option] ?? option;
}

/** 1c: is the video longer than this account may post? Unknown length is not "too long". */
export function tiktokVideoTooLong(durationSec: number | null | undefined, maxSec: number): boolean {
  if (durationSec == null || !Number.isFinite(durationSec) || !(maxSec > 0)) return false;
  // Allow for the browser rounding a 60.0 s clip to 60.02 s.
  return durationSec > maxSec + 0.05;
}

/** 75 -> "1:15", 3600 -> "1:00:00". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Why Publish is blocked for TikTok, or null. Only applies when TikTok is a
 * target: the user can always unselect TikTok and post elsewhere.
 * - `blockingReason`: from the TikTok panel (can't post now, settings didn't
 *   load, video too long).
 * - 3a: disclosure turned on with neither option ticked.
 */
export function tiktokPublishBlock(input: {
  tiktokSelected: boolean;
  blockingReason: string | null;
  commercialContentEnabled: boolean;
  metadata: Pick<TikTokPostMetadata, "brandedContent" | "brandOrganic">;
}): string | null {
  if (!input.tiktokSelected) return null;
  if (input.blockingReason) return input.blockingReason;
  if (input.commercialContentEnabled && !input.metadata.brandedContent && !input.metadata.brandOrganic) {
    return TIKTOK_DISCLOSURE_INCOMPLETE_TEXT;
  }
  return null;
}
