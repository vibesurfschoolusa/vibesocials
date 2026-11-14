/**
 * Where a video's cover image is stored (V1 fix round 1): `covers/<workspaceId>/<file>`.
 * Client-safe. The folder names the workspace, so POST /api/posts takes a cover
 * address only from the poster's own workspace, and /api/upload signs no token
 * for another workspace's folder.
 */

export const COVER_ADDRESS_REFUSED_MESSAGE =
  "That cover image belongs to another workspace. Choose the cover again and post once more.";

/** One plain file name: no slash, no escape, not a dot segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** The pathname a cover is uploaded to (no leading slash, as the upload takes it). */
export function coverBlobPathname(
  workspaceId: string,
  now: number = Date.now(),
  random: string = Math.random().toString(36).slice(2, 10),
): string {
  return `covers/${workspaceId}/${now}-${random}-cover.jpg`;
}

/** The raw and the decoded pathname of an address or a bare pathname, or null. */
function spellings(value: string): string[] | null {
  if (typeof value !== "string") return null;
  let pathname: string;
  try {
    pathname = new URL(value.trim(), "https://pathname.invalid/").pathname;
  } catch {
    return null;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: the raw path is judged alone.
  }
  // The raw value too: the URL parser removes dot segments before we see them.
  const raw = value.trim().replace(/^https?:\/\/[^/]+/i, "");
  const rawDecoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  return [pathname, decoded, raw.startsWith("/") ? raw : `/${raw}`, rawDecoded.startsWith("/") ? rawDecoded : `/${rawDecoded}`];
}

/** True when any spelling of `value` is under covers/ (any case, any slashes). */
export function isCoverAddress(value: string): boolean {
  return (spellings(value) ?? []).some((path) => /^\/+covers(\/|$)/i.test(path));
}

/**
 * True only for `…/covers/<workspaceId>/<one plain file name>`, spelled exactly
 * so: no other case, escape, dot segment or extra folder.
 */
export function isWorkspaceCoverAddress(value: string, workspaceId: string): boolean {
  const paths = spellings(value);
  if (!paths) return false;
  const prefix = `/covers/${workspaceId}/`;
  return paths.every((path) => path.startsWith(prefix) && SAFE_SEGMENT.test(path.slice(prefix.length)));
}

/** /api/upload: the 400 sentence for a token under covers/ that is not this workspace's, else null. */
export function coverUploadRefusal(pathname: string, workspaceId: string): string | null {
  if (!isCoverAddress(pathname)) return null;
  return isWorkspaceCoverAddress(pathname, workspaceId) ? null : COVER_ADDRESS_REFUSED_MESSAGE;
}
