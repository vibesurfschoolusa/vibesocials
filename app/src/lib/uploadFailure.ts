/**
 * Usage limits (2026-11-10): `upload()` from @vercel/blob/client throws a
 * generic "Failed to retrieve the client token" when /api/upload refuses a
 * token, and drops the response body that says why. After a failed upload,
 * Create and the Media page ask GET /api/upload whether the workspace's storage
 * is full, so the user reads that sentence instead of the generic failure.
 */

/** An upload refused for a reason the user can act on; `message` is the sentence to show. */
export class UploadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRefusedError";
  }
}

/** The storage sentence when that is why the upload failed, else the original error. */
export async function explainUploadFailure(
  error: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  try {
    const response = await fetchImpl("/api/upload", { method: "GET" });
    if (!response.ok) return original;
    const body = (await response.json()) as { storageFull?: unknown; error?: unknown } | null;
    if (body?.storageFull === true && typeof body.error === "string" && body.error) {
      return new UploadRefusedError(body.error);
    }
  } catch {
    // The question is best-effort: the original error still says something.
  }
  return original;
}
