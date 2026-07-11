import type { Platform } from "@prisma/client";

/**
 * Human-readable platform names for display. Display-only — never carries
 * tokens or account secrets, safe to import into client components.
 */
export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
  facebook_page: "Facebook Page",
  google_business_profile: "Google Business Profile",
};

/** Stable display order for platform chips / status badges. */
export const PLATFORM_ORDER: readonly Platform[] = [
  "tiktok",
  "youtube",
  "instagram",
  "x",
  "linkedin",
  "facebook_page",
  "google_business_profile",
];

/** Resolve a platform's display label, falling back to the raw enum value. */
export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * Task 7 — human-readable labels for TikTok's privacy levels, shown in the
 * publish-now confirmation dialog (composer) and the Queue's target/privacy
 * summary line. Falls back to the raw value for any level not listed here
 * (mirrors `platformLabel`'s fallback pattern). Single definition — Task 8
 * moved this here from a local copy in create-post-form.tsx so both call
 * sites stay in sync.
 */
export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Public (everyone)",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  SELF_ONLY: "Private (only me)",
  FOLLOWER_OF_CREATOR: "Followers",
};
