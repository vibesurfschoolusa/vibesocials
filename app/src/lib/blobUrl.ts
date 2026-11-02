/**
 * Host allowlist for client-supplied media blob URLs.
 *
 * POST /api/media and POST /api/posts accept a `blobUrl` that later becomes
 * the source platforms fetch when publishing. Without an allowlist an
 * authenticated user could point storageLocation at an arbitrary URL
 * (SSRF / content-laundering via connected business accounts).
 *
 * Allowed by default:
 * - Vercel Blob public hosts (`*.public.blob.vercel-storage.com`,
 *   `*.blob.vercel-storage.com`)
 * - Loopback (`localhost` / `127.0.0.1` / `[::1]`) for local filesystem
 *   storage and the e2e mock blob server (CI runs `next start` with
 *   NODE_ENV=production against http://localhost:9366 — loopback is still
 *   not a remote SSRF target for cloud metadata / internal VPC)
 * - Hosts listed in `BLOB_ALLOWED_HOSTS` (comma-separated), for custom CDNs
 *
 * Protocol: https for remote hosts; http allowed only for loopback.
 */

const VERCEL_BLOB_SUFFIXES = [
  ".public.blob.vercel-storage.com",
  ".blob.vercel-storage.com",
] as const;

function extraAllowedHosts(): string[] {
  const raw = process.env.BLOB_ALLOWED_HOSTS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isVercelBlobHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return VERCEL_BLOB_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * Returns true when `url` is a well-formed absolute URL whose host is on the
 * allowlist and whose protocol is acceptable for this environment.
 */
export function isAllowedBlobUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal = isLocalDevHost(host);

  if (parsed.protocol === "https:") {
    // ok for any allowed host
  } else if (parsed.protocol === "http:" && isLocal) {
    // Loopback over http: local storage + e2e mock blob (CI uses production
    // NODE_ENV with NEXT_PUBLIC_VERCEL_BLOB_API_URL=http://localhost:9366).
  } else {
    return false;
  }

  if (isVercelBlobHost(host)) {
    return true;
  }

  if (isLocal) {
    return true;
  }

  if (extraAllowedHosts().includes(host)) {
    return true;
  }

  return false;
}

/**
 * RFC 3986 section 6.2.2.2: a percent-escape of an unreserved character
 * (`A-Z a-z 0-9 - . _ ~`) names the same byte as the character itself, and the
 * hex digits of every other escape are case-insensitive. Fold both so equal
 * paths compare equal as strings.
 */
function normalizePercentEncoding(pathname: string): string {
  return pathname.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /^[A-Za-z0-9\-._~]$/.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Returns the ONE canonical spelling of an allowed blob URL, or `null` when the
 * URL is not acceptable as a stored `MediaItem.storageLocation`.
 *
 * 2026-11-01 audit (M2): `deleteBlobUnlessShared` decides whether a file is
 * still in use by comparing `storageLocation` strings. If two spellings of the
 * same file (`?x=1`, an upper-case host, `:443`, stray whitespace, ...) could be
 * stored, a member could register a teammate's blob under a variant spelling,
 * delete their own row, and get the teammate's file deleted. Every write path
 * therefore stores this canonical form and rejects what cannot be canonicalized.
 *
 * Rejected (`null`): anything `isAllowedBlobUrl` refuses, credentials, a query
 * or fragment (even an empty `?` / `#`), and an explicit non-default port on a
 * non-local host. Local dev hosts keep their port, because the e2e mock blob
 * server hands out `http://localhost:9366/<key>`. WHATWG parsing drops a
 * default port, so `https://host:443/p` is indistinguishable from
 * `https://host/p` and canonicalizes to the latter.
 *
 * Real `upload()` URLs (`https://<store>.public.blob.vercel-storage.com/<key>`)
 * and the mock's URLs are already canonical and come back unchanged.
 */
export function canonicalBlobUrl(url: string): string | null {
  if (typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  if (!isAllowedBlobUrl(trimmed)) {
    return null;
  }
  // A literal `?` / `#` is rejected even when WHATWG would parse it as an empty
  // search/hash, so no stored value ever carries either character.
  if (/[?#]/.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  // `hostname` and `protocol` are lower-cased and dot segments are resolved by
  // the parser; `host` additionally carries a non-default port.
  const isLocal = isLocalDevHost(parsed.hostname);
  if (parsed.port !== "" && !isLocal) {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}${normalizePercentEncoding(parsed.pathname)}`;
}

/** User-facing error copy shared by media + posts create routes. */
export const BLOB_URL_REJECTED_MESSAGE =
  "Media URL is not from an allowed storage host.";
