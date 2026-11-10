import { PINTEREST_SCOPES } from "@/lib/oauthScopes";
import { fitTitle, truncateGraphemes } from "@/lib/truncate";

/**
 * Pinterest API v5: the endpoints, limits and small pure helpers the connect
 * routes and server/platforms/pinterestClient.ts share. Every value is from
 * Pinterest's published API description
 * (https://github.com/pinterest/api-description, v5/openapi.yaml, version
 * 5.28.0, read 2026-11-10). No secrets: safe to import anywhere.
 */

export const PINTEREST_API_BASE_URL = "https://api.pinterest.com/v5";
/** Where the user approves the app ("pinterest_oauth2" authorizationUrl). */
export const PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
/** POST, HTTP Basic auth (app id : app secret), form-encoded body. */
export const PINTEREST_TOKEN_URL = `${PINTEREST_API_BASE_URL}/oauth/token`;

/** PinCreate.title maxLength. */
export const PINTEREST_TITLE_MAX = 100;
/** PinCreate.description maxLength. */
export const PINTEREST_DESCRIPTION_MAX = 800;
/** PinCreate.link maxLength. */
export const PINTEREST_LINK_MAX = 2048;

export interface PinterestConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

/**
 * The Pinterest app's credentials, or null when the deployment has none: the
 * connect routes then answer `pinterest_not_configured` and Settings does not
 * list Pinterest at all (app/settings/page.tsx).
 */
export function pinterestConfig(
  env: Record<string, string | undefined> = process.env,
): PinterestConfig | null {
  const appId = env.PINTEREST_APP_ID?.trim();
  const appSecret = env.PINTEREST_APP_SECRET?.trim();
  const redirectUri = env.PINTEREST_REDIRECT_URI?.trim();
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

/** The token endpoint's `Authorization` header. */
export function pinterestBasicAuthHeader(appId: string, appSecret: string): string {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
}

/** The URL the connect redirects to. Pinterest takes the scopes comma separated. */
export function buildPinterestAuthorizeUrl({
  appId,
  redirectUri,
  state,
}: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(PINTEREST_AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

/** Unicode code points, which is what a JSON `maxLength` counts. */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * The Pin's title: the post's own caption fitted to Pinterest's 100 characters
 * the way a YouTube title is (lib/truncate.ts fitTitle: whole sentences, never
 * mid-word), then shortened further while it is over 100 code points. Pinterest
 * refuses the whole Pin for a title over the limit, and one emoji can be several
 * code points. Empty when nothing fits.
 */
export function fitPinterestTitle(text: string): string {
  let graphemes = PINTEREST_TITLE_MAX;
  let fitted = fitTitle(text, graphemes);
  while (graphemes > 1 && codePointLength(fitted) > PINTEREST_TITLE_MAX) {
    graphemes -= Math.max(1, Math.ceil((codePointLength(fitted) - PINTEREST_TITLE_MAX) / 8));
    fitted = fitTitle(text, Math.max(1, graphemes));
  }
  return codePointLength(fitted) <= PINTEREST_TITLE_MAX ? fitted : "";
}

/**
 * The Pin's description: the caption, cut to Pinterest's 800 characters with
 * "..." when it is longer. Cut on whole graphemes (like every other client and
 * the composer preview, lib/platformLimits.ts), then shortened further if that
 * is still over 800 code points: one emoji can be several, and Pinterest
 * refuses the whole Pin for a description over the limit.
 */
export function fitPinterestDescription(text: string): string {
  let graphemes = PINTEREST_DESCRIPTION_MAX;
  let fitted = truncateGraphemes(text, graphemes, { ellipsis: "..." });
  while (graphemes > 0 && codePointLength(fitted) > PINTEREST_DESCRIPTION_MAX) {
    // Every grapheme is at least one code point, so dropping the excess (and at
    // least one) always gets closer.
    graphemes -= Math.max(1, Math.ceil((codePointLength(fitted) - PINTEREST_DESCRIPTION_MAX) / 8));
    fitted = truncateGraphemes(text, graphemes, { ellipsis: "..." });
  }
  return fitted;
}

/**
 * The Pin's destination link from the workspace's website (Settings > Captions):
 * an http(s) URL of at most 2,048 characters, with https:// added to a website
 * saved without a scheme. Null when there is no usable website: the Pin is then
 * created without a link.
 */
export function pinterestPinLink(website: string | null | undefined): string | null {
  const raw = website?.trim();
  if (!raw) return null;
  // Only "scheme://" counts as a scheme: "example.com:8080" is a host and port.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // "mailto:a@b.com" would parse as a host with credentials: not a website.
  if (url.username || url.password) return null;
  // A hostname without a dot ("not a url" parses as one with spaces escaped) is
  // not a website anyone can open.
  if (!url.hostname.includes(".")) return null;
  const link = url.toString();
  return link.length <= PINTEREST_LINK_MAX ? link : null;
}

export interface PinterestBoard {
  id: string;
  name: string;
  /** PUBLIC, PROTECTED or SECRET; null when Pinterest didn't say. */
  privacy: string | null;
}

/** One page of GET /boards: the boards we can use, and the next page's bookmark. */
export function parsePinterestBoards(body: unknown): {
  boards: PinterestBoard[];
  bookmark: string | null;
} {
  const page = body as { items?: unknown; bookmark?: unknown } | null;
  const items = Array.isArray(page?.items) ? page.items : [];
  const boards: PinterestBoard[] = [];
  for (const item of items) {
    const board = item as { id?: unknown; name?: unknown; privacy?: unknown } | null;
    if (typeof board?.id !== "string" || board.id === "") continue;
    if (typeof board.name !== "string" || board.name.trim() === "") continue;
    boards.push({
      id: board.id,
      name: board.name,
      privacy: typeof board.privacy === "string" ? board.privacy : null,
    });
  }
  const bookmark = typeof page?.bookmark === "string" && page.bookmark !== "" ? page.bookmark : null;
  return { boards, bookmark };
}

/** The integer `code` of Pinterest's error body (`{ code, message }`), or null. */
export function readPinterestErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown } | null;
    return typeof parsed?.code === "number" && Number.isInteger(parsed.code) ? parsed.code : null;
  } catch {
    return null;
  }
}
