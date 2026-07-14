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

/** User-facing error copy shared by media + posts create routes. */
export const BLOB_URL_REJECTED_MESSAGE =
  "Media URL is not from an allowed storage host.";
