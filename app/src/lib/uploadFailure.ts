/**
 * Usage limits (2026-11-10): `upload()` from @vercel/blob/client throws a
 * generic "Failed to retrieve the client token" when /api/upload refuses a
 * token, and drops the response body that says why. After a failed upload,
 * Create and the Media page ask GET /api/upload why (the workspace's storage is
 * full, or the reason the route remembered for this person's refused token),
 * so the user reads that sentence instead of the generic failure.
 */

import { SIGNED_OUT_ERROR } from "./signedOutMessage";
import { readWorkspaceRefusalText, withWorkspaceId } from "./workspaceChanged";

/**
 * An upload failure explained in a sentence the user can act on (refused,
 * storage full, signed out, never reached us); `message` is the sentence to
 * show. Every sentence explainUploadFailure writes comes as this type.
 */
export class UploadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRefusedError";
  }
}

/**
 * 07c: /api/upload refused the token but storage is not full, most likely its
 * rate limit after many files at once.
 */
export const UPLOAD_REFUSED_MESSAGE =
  "The upload was refused. If you are adding many files, wait a few minutes and try again.";

/**
 * R24 new-customer L3: the upload never reached us. Create and Add many show
 * the message, which would otherwise be the browser's "Failed to fetch".
 */
export const UPLOAD_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so the file wasn't uploaded. Check your connection and try again.";

/**
 * The upload's request dropped but our own question was answered: the file
 * storage host is what failed (blocked by a school or office filter, or down).
 */
export const UPLOAD_STORAGE_UNREACHABLE_MESSAGE =
  "The file couldn't be uploaded. Vibe Socials answered, but its file storage couldn't be reached from this network. Try again, or try another connection.";

/**
 * R53 pages-a L2/L3: file storage itself answered and refused the upload (a
 * suspended store, access denied, its rate limit, an unknown error after its
 * retries). The blob client's own text names the vendor and links its help
 * page, so it is never shown; this is.
 */
export const UPLOAD_STORAGE_REFUSED_MESSAGE = "File storage didn't take the upload. Try again in a few minutes.";

// Every error @vercel/blob throws (its BlobError) starts with this.
const BLOB_ERROR = /^Vercel Blob:/;

// What the blob client throws when the token route answers non-2xx (its own
// text has a double space in one spelling).
const TOKEN_REFUSED = /failed to\s+retrieve the client token/i;

// What it throws when a part's request drops, and on a real outage.
const BLOB_SERVICE_UNAVAILABLE = /blob service is currently not available/i;

/**
 * A storage refusal: one of the blob client's own errors, except the two that
 * keep their own sentences (a dropped request's "not available", and a
 * refused token). Create, Add many and /u decide by this one rule.
 */
export function isStorageRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !BLOB_ERROR.test(error.message)) return false;
  return !BLOB_SERVICE_UNAVAILABLE.test(error.message) && !TOKEN_REFUSED.test(error.message);
}

/**
 * The storage sentence when that is why the upload failed; for any other
 * refused token, UPLOAD_REFUSED_MESSAGE; for a dropped request,
 * UPLOAD_OFFLINE_MESSAGE when our own question fails too, else
 * UPLOAD_STORAGE_UNREACHABLE_MESSAGE; for a storage refusal,
 * UPLOAD_STORAGE_REFUSED_MESSAGE; else the original error.
 */
export async function explainUploadFailure(
  error: unknown,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  // A request that got no answer: fetch's TypeError (the browser's own text),
  // or the blob client's "not available". One rule for both, decided by
  // whether our own question below is answered.
  const dropped = original instanceof TypeError || BLOB_SERVICE_UNAVAILABLE.test(original.message);
  const refused = TOKEN_REFUSED.test(original.message)
    ? new UploadRefusedError(UPLOAD_REFUSED_MESSAGE)
    : isStorageRefusal(original)
      ? new UploadRefusedError(UPLOAD_STORAGE_REFUSED_MESSAGE)
      : null;
  let response: Response;
  try {
    // R32: asked for the workspace the page was drawn for, as the upload itself is.
    response = await fetchImpl(uploadRouteUrl(workspaceId), { method: "GET" });
  } catch {
    return refused ?? (dropped ? new UploadRefusedError(UPLOAD_OFFLINE_MESSAGE) : original);
  }
  const otherwise = refused ?? (dropped ? new UploadRefusedError(UPLOAD_STORAGE_UNREACHABLE_MESSAGE) : original);
  try {
    // R20 new-customer L2: the session ended (another tab, a new password).
    // That is why the upload failed, whatever the blob client threw; the
    // route's own sentence says so.
    if (response.status === 401) return new UploadRefusedError(await signedOutText(response));
    // R32: the page is for another workspace (or from before the id was sent):
    // that is why the upload was refused too, so the shared sentence says it.
    const workspaceRefusal = await readWorkspaceRefusalText(response);
    if (workspaceRefusal) return new UploadRefusedError(workspaceRefusal);
    if (!response.ok) return otherwise;
    // `refused`: the route remembered why it refused this person's token (an
    // out-of-date page, the day's 20 GB), app/api/upload/uploadRefusal.ts.
    const body = (await response.json()) as { storageFull?: unknown; refused?: unknown; error?: unknown } | null;
    if ((body?.storageFull === true || body?.refused === true) && typeof body.error === "string" && body.error) {
      return new UploadRefusedError(body.error);
    }
  } catch {
    // The question is best-effort: the original error still says something.
  }
  return otherwise;
}

/** The 401's `error`, or the shared sentence when the body cannot be read. */
async function signedOutText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the shared sentence.
  }
  return SIGNED_OUT_ERROR;
}

/**
 * R31: the upload route for `upload()`'s handleUploadUrl, with the workspace
 * the page was drawn for, so a tab left on another workspace gets no token
 * there (the route remembers why, and explainUploadFailure says it).
 */
export function uploadRouteUrl(workspaceId: string): string {
  return withWorkspaceId("/api/upload", workspaceId);
}
