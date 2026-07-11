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
  facebook_page: "Facebook",
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
