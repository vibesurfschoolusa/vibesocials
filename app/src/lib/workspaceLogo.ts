/**
 * The workspace's report logo (18b): the limits and the sentences shared by
 * POST/DELETE /api/workspaces/logo and the Settings control. The server half
 * (reading the body, decoding and re-encoding) is src/server/workspaceLogo.ts.
 */

/** Largest upload accepted, in bytes (1 MB). */
export const LOGO_MAX_BYTES = 1024 * 1024;
/** The stored PNG fits inside this box; a smaller picture is never enlarged. */
export const LOGO_MAX_WIDTH = 600;
export const LOGO_MAX_HEIGHT = 300;
/** Uploads and removals an owner may make per hour. */
export const LOGO_CHANGES_PER_HOUR = 10;

export const LOGO_HELP_LINE = "An image up to 1 MB (not SVG). It appears on your monthly report.";

export const LOGO_TOO_LARGE_MESSAGE = "That file is over 1 MB. Choose a smaller PNG or JPEG.";
export const LOGO_EMPTY_MESSAGE = "No file arrived. Choose a PNG or JPEG and try again.";
export const LOGO_NOT_IMAGE_MESSAGE =
  "That file isn't a picture we can read. Choose a PNG or JPEG, up to 1 MB.";
export const LOGO_SVG_MESSAGE = "SVG files can't be used as a logo. Choose a PNG or JPEG, up to 1 MB.";
export const LOGO_LIMIT_MESSAGE = "You've changed the logo 10 times in the last hour. Try again later.";
export const LOGO_SAVE_FAILED_MESSAGE = "Couldn't save the logo. Nothing was changed. Try again.";
export const LOGO_REMOVE_FAILED_MESSAGE = "Couldn't remove the logo. Nothing was changed. Try again.";

export const LOGO_ADDRESS_RESERVED_MESSAGE =
  "That file address belongs to a workspace logo and can't be used here. Upload the file instead.";

/**
 * True when `value` (a file address, or a bare pathname) is under `logos/`.
 * Fix round 1 (18b): logos are the server's own files and have no MediaItem row
 * to protect them, and their addresses are public (the client's report, the
 * email). So no route takes one from a client: registered as someone's media,
 * deleting that media would delete the logo. Every spelling the store or the
 * URL parser could resolve to logos/ counts: case, percent-encoding, dot
 * segments, repeated slashes, an encoded slash.
 */
export function isLogoAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  let pathname: string;
  try {
    pathname = new URL(value.trim(), "https://pathname.invalid/").pathname;
  } catch {
    return false;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: judge the raw path only.
  }
  return [pathname, decoded].some((path) => /^\/+logos\//i.test(path));
}

/** The 400 sentence for a client-supplied logo address, or null when the address may be used. */
export function logoAddressRefusal(value: string): string | null {
  return isLogoAddress(value) ? LOGO_ADDRESS_RESERVED_MESSAGE : null;
}

/**
 * The logo route for the workspace a page was rendered for: the route answers
 * 409 when the session's active workspace has changed since (another tab).
 */
export function logoEndpoint(workspaceId: string): string {
  return `/api/workspaces/logo?workspaceId=${encodeURIComponent(workspaceId)}`;
}
