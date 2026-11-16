/**
 * Usage limits (2026-11-10): `upload()` from @vercel/blob/client throws a
 * generic "Failed to retrieve the client token" when /api/upload refuses a
 * token, and drops the response body that says why. After a failed upload,
 * Create and the Media page ask GET /api/upload why (the workspace's storage is
 * full, or the reason the route remembered for this person's refused token),
 * so the user reads that sentence instead of the generic failure.
 */

import { SIGNED_OUT_ERROR } from "./signedOutMessage";

/** An upload refused for a reason the user can act on; `message` is the sentence to show. */
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

// What the blob client throws when the token route answers non-2xx (its own
// text has a double space in one spelling).
const TOKEN_REFUSED = /failed to\s+retrieve the client token/i;

// What it throws when a part's request drops; also its answer to a real
// outage, so it means "offline" only when our own question fails too.
const BLOB_SERVICE_UNAVAILABLE = /blob service is currently not available/i;

/**
 * The storage sentence when that is why the upload failed; for any other
 * refused token, UPLOAD_REFUSED_MESSAGE; for a request that never left,
 * UPLOAD_OFFLINE_MESSAGE; else the original error.
 */
export async function explainUploadFailure(
  error: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  // fetch throws a TypeError only when no answer came (the browser's own text).
  const otherwise = TOKEN_REFUSED.test(original.message)
    ? new UploadRefusedError(UPLOAD_REFUSED_MESSAGE)
    : original instanceof TypeError
      ? new Error(UPLOAD_OFFLINE_MESSAGE)
      : original;
  let response: Response;
  try {
    response = await fetchImpl("/api/upload", { method: "GET" });
  } catch {
    return BLOB_SERVICE_UNAVAILABLE.test(original.message) ? new Error(UPLOAD_OFFLINE_MESSAGE) : otherwise;
  }
  try {
    // R20 new-customer L2: the session ended (another tab, a new password).
    // That is why the upload failed, whatever the blob client threw; the
    // route's own sentence says so.
    if (response.status === 401) return new UploadRefusedError(await signedOutText(response));
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
