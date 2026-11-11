import type { Platform } from "@prisma/client";

import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { trackedWebsiteLink } from "@/lib/trackingTags";
import { removeXMentions } from "@/lib/xMentions";

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

function composeCaption(base: string, website: string | undefined, hashtags: string | undefined): string {
  const parts = [base];
  if (website) parts.push(`For more info visit ${website}`);
  if (hashtags) parts.push(hashtags);
  return parts.join("\n\n");
}

/**
 * Whether this text goes out whole on the platform. It is counted the way the
 * platform's client counts it: on X without @-mentions (xClient.ts removes them
 * before the cut). Code points are counted, not graphemes: every grapheme is at
 * least one code point, so text that passes here is cut by no client (Pinterest
 * also cuts on code points, lib/pinterestApi.ts).
 */
function fitsPlatformLimit(text: string, platform: Platform): boolean {
  const { charLimit } = PLATFORM_CAPTION_LIMITS[platform];
  if (charLimit === null) return true;
  const counted = platform === "x" ? removeXMentions(text) : text;
  return [...counted].length <= charLimit;
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
 * platform's tracking tags (lib/trackingTags.ts), but only when the whole text
 * still fits the platform's limit: the tags must never cost the post its text,
 * so otherwise the plain link is used. Without a platform or with the setting
 * off, the output is exactly what it was before tracking tags existed.
 */
export function buildCaptionWithFooter(
  baseCaption: string,
  user: CaptionFooterUser,
  platform?: Platform,
): string {
  const base = baseCaption.trim();
  const website = user.companyWebsite?.trim() || undefined;
  const hashtags = user.defaultHashtags?.trim() || undefined;
  const plain = composeCaption(base, website, hashtags);
  if (!platform || !user.trackWebsiteLinks || !website) return plain;

  const tagged = composeCaption(base, trackedWebsiteLink(website, platform), hashtags);
  return fitsPlatformLimit(tagged, platform) ? tagged : plain;
}
