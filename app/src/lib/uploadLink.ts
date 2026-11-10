/**
 * Client upload link (2026-11-10): the pure parts shared by the owner routes,
 * the two public routes under /api/upload-link/[token]/ and the /u/[token] page.
 *
 * The public routes are reachable without signing in, so everything a request
 * may name is checked against the link the token resolves to: the storage path
 * must sit under `ul/<link id>/`, which only this link's upload route hands out.
 */

/** Shown for an unknown AND a revoked link, so the two cannot be told apart. */
export const UPLOAD_LINK_INACTIVE_MESSAGE = "This link is not active. Ask for a new one.";

export const UPLOAD_LINK_STORAGE_FULL_MESSAGE =
  "This workspace cannot take more files right now. Tell the person who gave you the link.";

export const UPLOAD_LINK_DAILY_LIMIT_MESSAGE =
  "This link has reached today's limit. Try again tomorrow.";

export const UPLOAD_LINK_IP_LIMIT_MESSAGE =
  "Too many files from this network in the last hour. Try again later.";

export const UPLOAD_LINK_CREATE_LIMIT_MESSAGE =
  "Too many new links in the last hour. Try again later.";

/** Files one link takes in a UTC day, counted on the upload token and on the registration. */
export const UPLOAD_LINK_FILES_PER_DAY = 200;
/** Upload tokens, and separately registrations, one IP address gets in an hour. */
export const UPLOAD_LINK_IP_PER_HOUR = 60;
/** New links (create or replace) one owner makes in an hour. */
export const UPLOAD_LINK_CREATES_PER_HOUR = 10;
/** Longest sender name, and longest note. */
export const UPLOAD_LINK_TEXT_MAX = 200;

const STORED_NAME_MAX = 100;

export function uploadLinkStoragePrefix(linkId: string): string {
  return `ul/${linkId}/`;
}

/**
 * True when `url` names a file under this link's prefix. The URL parser resolves
 * dot segments first, so `/ul/<id>/../other` does not pass, and a `%2F` stays
 * escaped, so it cannot fake the slash after the id.
 */
export function isUploadLinkBlobPath(url: string, linkId: string): boolean {
  if (!linkId || linkId.includes("/")) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const prefix = `/${uploadLinkStoragePrefix(linkId)}`;
  return pathname.startsWith(prefix) && pathname.length > prefix.length;
}

/**
 * The storage path the upload route signs: this link's prefix, a random part so
 * two files never share a name, and the last part of the browser's file name
 * with anything unusual replaced (as lib/blobKey.ts does), capped at 100.
 */
export function uploadLinkPathname(linkId: string, fileName: string, random: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  let safe = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  if (/^\.*$/.test(safe)) safe = "file";
  if (safe.length > STORED_NAME_MAX) {
    const dot = safe.lastIndexOf(".");
    const ext = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
    safe = safe.slice(0, STORED_NAME_MAX - ext.length) + ext;
  }
  return `${uploadLinkStoragePrefix(linkId)}${random}-${safe}`;
}

/**
 * The sender's name or note as stored: trimmed, at most 200 characters (whole
 * characters, so an emoji is never cut in half), null when empty. A name is put
 * on one line because it goes into an email subject.
 */
export function cleanSenderText(
  value: unknown,
  options: { singleLine?: boolean } = {},
): string | null {
  if (typeof value !== "string") return null;
  let text = options.singleLine ? value.replace(/[\s\p{Cc}]+/gu, " ") : value;
  text = text.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > UPLOAD_LINK_TEXT_MAX) {
    text = chars.slice(0, UPLOAD_LINK_TEXT_MAX).join("").trim();
  }
  return text || null;
}

export function uploadLinkUrl(baseUrl: string | undefined, token: string): string {
  return `${baseUrl ?? ""}/u/${token}`;
}

/** Tokens are 32 random bytes as base64url: anything else is not worth a lookup. */
export function isUploadLinkTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** The UTC hour of `now`, for the once-an-hour email. */
export function uploadLinkHourWindow(now: Date): { key: string; end: Date } {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return {
    key: start.toISOString().slice(0, 13),
    end: new Date(start.getTime() + 60 * 60 * 1000),
  };
}

/** The caller's address as the register route reads it: the first x-forwarded-for entry. */
export function requestIp(request: Pick<Request, "headers">): string {
  return (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";
}
