import type { Platform } from "@prisma/client";

/** True for an absolute https URL (never javascript:, data: or plain http). */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Public URL of a published post: the link the platform returned
 * (`storedUrl`, PostJobResult.externalPostUrl: Instagram permalinks) when it is
 * an https URL, else one derived from the stored externalPostId, or null where
 * the id isn't a public locator (TikTok publish ids, Instagram media ids, GBP
 * media names).
 */
export function platformPostUrl(
  platform: Platform,
  externalPostId: string | null,
  storedUrl?: string | null,
): string | null {
  if (storedUrl && isHttpsUrl(storedUrl)) return storedUrl;
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
