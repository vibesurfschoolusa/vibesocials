/** Collision-safe, filesystem-safe Vercel Blob key for an upload. */
export function generateBlobKey(file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}-${safeName}`;
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
