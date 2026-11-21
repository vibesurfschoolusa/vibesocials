import type { Platform } from "@prisma/client";

import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { trackedWebsiteLink } from "@/lib/trackingTags";
import { graphemeCount } from "@/lib/truncate";
import { removeXMentions } from "@/lib/xMentions";
import { xWeightedLength } from "@/lib/xWeightedLength";

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
 * This text's length the way the platform's client counts it before its cut:
 * on X by X's weight without @-mentions (xClient.ts removes them first), on
 * LinkedIn in graphemes (linkedinClient.ts cuts with
 * truncateKeepingLinksAtWord). Other platforms count code points: every grapheme is at least one code point, so
 * text that passes here is cut by no client (Pinterest cuts on code points,
 * lib/pinterestApi.ts).
 */
function platformLength(text: string, platform: Platform): number {
  if (platform === "x") return xWeightedLength(removeXMentions(text));
  if (platform === "linkedin") return graphemeCount(text);
  // R65: TikTok cuts by UTF-16 units, more than code points for an emoji, so
  // the rule counts them too; otherwise a kept footer could still be cut.
  if (PLATFORM_CAPTION_LIMITS[platform].unit === "utf16") return text.length;
  return [...text].length;
}

function fitsPlatformLimit(text: string, platform: Platform): boolean {
  const { charLimit } = PLATFORM_CAPTION_LIMITS[platform];
  return charLimit === null || platformLength(text, platform) <= charLimit;
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
 *
 * On every platform with a limit, a text over it loses its footer parts whole,
 * the hashtags first, then the website line, before the client cuts the caption
 * (fix round 1, M5/M6, for X and LinkedIn; R5-publishing L2, for the rest): a
 * cut footer is a broken link or a half hashtag, and the post's own words
 * matter more. A platform without a limit always keeps the whole footer.
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
  if (!platform) return plain;

  const tagged = user.trackWebsiteLinks && website ? trackedWebsiteLink(website, platform) : undefined;
  // The footers to try, longest first. Each is tried with the tagged link, then
  // the plain one, so the tags never cost the post its hashtags.
  const footers: [string | undefined, string | undefined][] = [
    [website, hashtags],
    [website, undefined],
    [undefined, undefined],
  ];
  for (const [site, tags] of footers) {
    if (site && tagged) {
      const withTags = composeCaption(base, tagged, tags);
      if (fitsPlatformLimit(withTags, platform)) return withTags;
    }
    const untagged = composeCaption(base, site, tags);
    if (fitsPlatformLimit(untagged, platform)) return untagged;
  }
  // Still over: the client cuts the caption, sent without its footer.
  return base;
}
