export interface AssertOkOptions {
  /** Error code tagged on the thrown error (`error.code`), e.g. `"GOOGLE_TOKEN_REFRESH_FAILED"`. */
  code: string;
  /**
   * Human-readable prefix for the SANITIZED error message. The upstream response
   * body is NEVER appended to this — only `prefix` + the HTTP status appear in the
   * thrown message (which surfaces to users via `PostJobResult.errorMessage`).
   */
  prefix: string;
}

/**
 * Assert that a `fetch` Response is ok.
 *
 * If `res.ok`, returns the response so calls can chain.
 *
 * If not ok:
 * 1. Reads the response body defensively (`await res.text().catch(...)`).
 * 2. `console.error`s the RAW body + status server-side (for logs/debugging).
 * 3. Throws a SANITIZED error whose message contains only `prefix` + status —
 *    never the upstream body — and carries `error.code = code`.
 *
 * Rationale: `PostJobResult.errorMessage` stores `error.message` and the UI
 * renders it (see server/jobs/posting.ts + server/jobs/inngest-functions.ts),
 * so upstream bodies must reach server logs but never reach end users.
 */
export async function assertOk(
  res: Response,
  { code, prefix }: AssertOkOptions,
): Promise<Response> {
  if (res.ok) {
    return res;
  }

  const body = await res.text().catch(() => "<unable to read response body>");

  console.error(`${prefix} (status ${res.status})`, {
    status: res.status,
    statusText: res.statusText,
    body,
  });

  const error = new Error(`${prefix} (status ${res.status})`) as Error & {
    code: string;
  };
  error.code = code;
  throw error;
}
