import type { Platform } from "@prisma/client";

/**
 * The utm_source each platform's visits show up under in the client's Google
 * Analytics. Instagram and TikTok are missing on purpose: a link in their
 * captions cannot be clicked, so tags would only make the caption longer.
 */
const TRACKING_SOURCES: Partial<Record<Platform, string>> = {
  facebook_page: "facebook",
  linkedin: "linkedin",
  x: "x",
  youtube: "youtube",
  pinterest: "pinterest",
  google_business_profile: "google",
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The website read the way pinterestPinLink (lib/pinterestApi.ts) reads it: a
 * value without "scheme://" is taken as https. Null when it is not a web link.
 */
function readWebsite(raw: string): URL | null {
  if (!raw || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  return url;
}

function tagsFor(source: string): string {
  return `utm_source=${source}&utm_medium=social&utm_campaign=vibesocials`;
}

/**
 * Adds the tags to the text itself rather than returning `URL.toString()`, so
 * the link keeps the form the owner typed (no https:// added to
 * "vibesurfschool.com"). A link with no path gets a "/" before the "?", the
 * form every platform's link detection reads.
 */
function appendTags(raw: string, source: string): string {
  const hashAt = raw.indexOf("#");
  let base = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : raw.slice(hashAt);

  const scheme = SCHEME.exec(base)?.[0] ?? "";
  const rest = base.slice(scheme.length);
  const authority = rest.split(/[/?]/, 1)[0];
  if (rest.charAt(authority.length) !== "/") {
    base = `${scheme}${authority}/${rest.slice(authority.length)}`;
  }

  const tags = tagsFor(source);
  let tagged: string;
  if (!base.includes("?")) tagged = `${base}?${tags}`;
  else if (base.endsWith("?") || base.endsWith("&")) tagged = `${base}${tags}`;
  else tagged = `${base}&${tags}`;
  return `${tagged}${fragment}`;
}

/**
 * The workspace website with the tags that tell Google Analytics which
 * platform a visit came from. Returned unchanged for Instagram, TikTok and any
 * other platform without a source, for a value that is not a web link, and for
 * a link that already has a utm_source (the owner's own tags win).
 */
export function trackedWebsiteLink(website: string, platform: Platform): string {
  const source = TRACKING_SOURCES[platform];
  if (!source) return website;
  const raw = website.trim();
  const url = readWebsite(raw);
  if (!url || url.searchParams.has("utm_source")) return website;
  return appendTags(raw, source);
}

function siteHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * A Google post button's link, tagged as a Google visit only when it points at
 * the workspace website's own site ("www." or not). A booking page on another
 * site is left alone: its owner's analytics are not the client's.
 */
export function trackedGoogleButtonUrl(buttonUrl: string, website: string | null | undefined): string {
  const button = readWebsite(buttonUrl.trim());
  const site = readWebsite(website?.trim() ?? "");
  if (!button || !site || siteHost(button) !== siteHost(site)) return buttonUrl;
  return trackedWebsiteLink(buttonUrl, "google_business_profile");
}
