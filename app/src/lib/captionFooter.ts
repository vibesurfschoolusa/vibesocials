import type { Platform } from "@prisma/client";

import { trackedWebsiteLink } from "@/lib/trackingTags";

/**
 * The subset of the posting user that contributes an optional footer to a
 * published caption. Only the fields actually read are modeled here; a full
 * Prisma `User` (or the serialized user passed through Inngest steps) is
 * structurally assignable to this shape.
 */
export interface CaptionFooterUser {
  companyWebsite?: string | null;
  defaultHashtags?: string | null;
  /** The workspace's tracking-tags setting; only read when a platform is passed. */
  trackWebsiteLinks?: boolean | null;
}

/**
 * Compose the published caption from a base caption plus the user's optional
 * footer: a "For more info visit <website>" line, then the default hashtags.
 *
 * The segment order and the `\n\n` (blank-line) separators are load-bearing and
 * asserted by captionFooter.test.ts. Each footer segment is omitted when its
 * source field is empty, whitespace-only, null, or undefined. The base caption
 * is always included (trimmed), even when empty.
 *
 * With a `platform` and `trackWebsiteLinks` on, the website carries that
 * platform's tracking tags (lib/trackingTags.ts). Without either, the output
 * is exactly what it was before tracking tags existed.
 */
export function buildCaptionWithFooter(
  baseCaption: string,
  user: CaptionFooterUser,
  platform?: Platform,
): string {
  const parts = [baseCaption.trim()];

  const website = user.companyWebsite?.trim();
  if (website) {
    const link = platform && user.trackWebsiteLinks ? trackedWebsiteLink(website, platform) : website;
    parts.push(`For more info visit ${link}`);
  }

  if (user.defaultHashtags?.trim()) {
    parts.push(user.defaultHashtags.trim());
  }

  return parts.join("\n\n");
}
