/** Collision-safe, filesystem-safe Vercel Blob key for an upload. */
export function generateBlobKey(file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}-${safeName}`;
}

/**
 * What a log may say about a stored file's address (R68 lead follow-up): the
 * key ends in the customer's file name, so only the host and the key's
 * "<ms>-<random>" part, which is enough to find the file.
 */
export function blobLogRef(url: unknown): string {
  if (typeof url !== "string") return "(unparseable)";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(unparseable)";
  }
  const key = parsed.pathname.slice(1);
  const lead = /^(\d{13}-[a-z0-9]{0,8})-/.exec(key);
  return lead ? `${parsed.host}/${lead[1]}` : parsed.host;
}

/**
 * The shape generateBlobKey makes (the random part can come out short). POST
 * /api/upload signs no other root pathname, so every signed-in upload is a file
 * the orphan sweep (server/jobs/orphanBlobSweep.ts) recognises and can delete.
 */
const SIGNED_IN_UPLOAD_KEY = /^\d{13}-[a-z0-9]{0,8}-[A-Za-z0-9._-]+$/;

export function isSignedInUploadKey(pathname: string): boolean {
  return typeof pathname === "string" && SIGNED_IN_UPLOAD_KEY.test(pathname);
}

/** /api/upload's 400 for a pathname the app does not make: most likely a page open since before a release. */
export const UPLOAD_PATH_REFUSED_MESSAGE = "This page is out of date. Reload it, then try again.";

/**
 * The token request's clientPayload for every signed-in upload: /api/upload
 * counts this size against the person's day and signs it as the file's maximum.
 */
export function uploadSizePayload(file: Blob): string {
  return JSON.stringify({ size: file.size });
}
