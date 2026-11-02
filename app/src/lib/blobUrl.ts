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
 *
 * Own-store pin (2026-11-01 audit, M2): when this deployment's Blob store id is
 * known (see {@link ownBlobStoreId}), a Vercel Blob URL is allowed only on that
 * store's host. The Blob API can resolve a URL by the token's store plus the
 * pathname, so the same pathname under another store's host must not be
 * accepted as ours (it would be a distinct string for the shared-blob guard
 * but name our file). Without a known store id the check is unchanged.
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

/**
 * This deployment's Vercel Blob store id, lower-cased, or `null` when unknown.
 *
 * Derived exactly as `@vercel/blob` derives it (dist/chunk-XKVPKJPO.js):
 * `BLOB_READ_WRITE_TOKEN` is `vercel_blob_rw_<storeId>_<secret>`, so the id is
 * its 4th underscore-separated segment; otherwise `BLOB_STORE_ID` with a
 * leading `store_` stripped. The library builds public URLs as
 * `https://<storeId>.public.blob.vercel-storage.com/<pathname>`.
 */
export function ownBlobStoreId(): string | null {
  const fromToken = process.env.BLOB_READ_WRITE_TOKEN?.trim().split("_")[3]?.trim();
  if (fromToken) {
    return fromToken.toLowerCase();
  }
  const raw = process.env.BLOB_STORE_ID?.trim() ?? "";
  const fromEnv = raw.startsWith("store_") ? raw.slice("store_".length).trim() : raw;
  return fromEnv ? fromEnv.toLowerCase() : null;
}

/** The only Vercel Blob hosts of store `storeId` (lower-case). */
function ownStoreHosts(storeId: string): string[] {
  return [
    `${storeId}.public.blob.vercel-storage.com`,
    `${storeId}.private.blob.vercel-storage.com`,
  ];
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
    const storeId = ownBlobStoreId();
    // Store known: only its own hosts. A foreign Blob host falls through, so an
    // operator who lists it in BLOB_ALLOWED_HOSTS still gets it.
    if (storeId === null || ownStoreHosts(storeId).includes(host)) {
      return true;
    }
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

/**
 * The key the shared-blob guard (`deleteBlobUnlessShared`) locks on, counts
 * against and deletes. A LENIENT canonical form: where {@link canonicalBlobUrl}
 * rejects a spelling (and a stored legacy row can still hold one), this strips
 * the part that makes it a different string instead, so the row still meets its
 * canonical twin.
 *
 * 2026-11-01 audit (M2, ruling R6): parse the raw value (unparseable: use it
 * as is); clear search, hash, username and password; clear the port unless the
 * host is a local dev host; when the host is any Vercel Blob host and our own
 * store id is known, point it at `<ownStoreId>.public.blob.vercel-storage.com`
 * (the Blob API may resolve by token store + pathname, so another store's host
 * with our pathname IS our file); then {@link canonicalBlobUrl} the result, and
 * fall back to the raw value when that still returns `null`.
 */
export function guardBlobKey(raw: string): string {
  let parsed: URL;
  try {
    // JS trim() first, like canonicalBlobUrl: WHATWG parsing only strips C0
    // controls and plain spaces, not U+FEFF / U+00A0 / U+2028 padding that old
    // POST /api/posts rows can carry.
    parsed = new URL(raw.trim());
  } catch {
    return raw;
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  if (!isLocalDevHost(parsed.hostname)) {
    parsed.port = "";
  }
  const storeId = ownBlobStoreId();
  if (storeId !== null && isVercelBlobHost(parsed.hostname)) {
    parsed.hostname = `${storeId}.public.blob.vercel-storage.com`;
  }
  return canonicalBlobUrl(parsed.href) ?? raw;
}

/** User-facing error copy shared by media + posts create routes. */
export const BLOB_URL_REJECTED_MESSAGE =
  "Media URL is not from an allowed storage host.";
