import type { Platform } from "@prisma/client";

/**
 * Public URL of a published post, derivable from the stored externalPostId
 * alone — or null where the id isn't a public locator (TikTok publish ids,
 * Instagram media ids, GBP media names).
 */
export function platformPostUrl(platform: Platform, externalPostId: string | null): string | null {
  if (!externalPostId) return null;
  switch (platform) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(externalPostId)}`;
    case "x":
      return `https://x.com/i/web/status/${encodeURIComponent(externalPostId)}`;
    case "linkedin":
      // LinkedIn's externalPostId is a structured URN ("urn:li:share:...") —
      // encodeURIComponent would percent-escape its colons and mangle the
      // URL. encodeURI preserves reserved URI characters (":", "/") while
      // still escaping anything genuinely unsafe (spaces, unicode).
      return `https://www.linkedin.com/feed/update/${encodeURI(externalPostId)}`;
    case "facebook_page":
      return `https://www.facebook.com/${encodeURIComponent(externalPostId)}`;
    default:
      return null;
  }
}
