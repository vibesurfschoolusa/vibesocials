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
 * media names). A Story (`opts.story`, 2026-11-10) gets only the returned link:
 * a Facebook Story's id does not open the Story.
 */
export function platformPostUrl(
  platform: Platform,
  externalPostId: string | null,
  storedUrl?: string | null,
  opts?: { story?: boolean },
): string | null {
  if (storedUrl && isHttpsUrl(storedUrl)) return storedUrl;
  if (!externalPostId || opts?.story) return null;
  switch (platform) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(externalPostId)}`;
    case "x":
      return `https://x.com/i/web/status/${encodeURIComponent(externalPostId)}`;
    case "linkedin":
      // LinkedIn's externalPostId is the post URN the Posts API answered in
      // `x-restli-id`: "urn:li:share:..." or "urn:li:ugcPost:..." (legacy
      // ugcPosts ids are the same forms). /feed/update/{urn} opens either
      // (posts-api: "https://www.linkedin.com/feed/update/urn:li:ugcPost:<id>/").
      // encodeURIComponent would percent-escape its colons and mangle the
      // URL. encodeURI preserves reserved URI characters (":", "/") while
      // still escaping anything genuinely unsafe (spaces, unicode).
      return `https://www.linkedin.com/feed/update/${encodeURI(externalPostId)}`;
    case "facebook_page":
      return `https://www.facebook.com/${encodeURIComponent(externalPostId)}`;
    case "pinterest":
      // The Pin's id from POST /pins (server/platforms/pinterestClient.ts).
      return `https://www.pinterest.com/pin/${encodeURIComponent(externalPostId)}/`;
    default:
      return null;
  }
}
