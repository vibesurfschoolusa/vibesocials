/**
 * Error code tagged on the error thrown when {@link fetchWithTimeout} aborts a
 * request because it exceeded `timeoutMs`. Consumers can branch on this via
 * `(error as { code?: string }).code === FETCH_TIMEOUT_CODE`, matching the
 * `(error as any).code` tagging convention used across this codebase.
 */
export const FETCH_TIMEOUT_CODE = "FETCH_TIMEOUT";

/** Default request timeout: 30 seconds. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * `fetch` wrapper that aborts the request after `timeoutMs` and throws a
 * distinguishable timeout error (`error.code === FETCH_TIMEOUT_CODE`).
 *
 * Timeout scope — IMPORTANT: `timeoutMs` covers the connection + response
 * headers phase ONLY. The internal timer is cleared (and the caller-signal
 * listener removed) in a `finally` that runs as soon as the underlying
 * `fetch()` call settles, i.e. once headers arrive — BEFORE the response body
 * is read. Consuming the body afterward (`res.json()`, `res.text()`,
 * `res.arrayBuffer()`, streaming `res.body`, etc.) is NOT bounded by this
 * timeout. Callers that read large/slow bodies (e.g. a future
 * `downloadToBuffer`, media downloads) MUST apply their own bound around body
 * consumption — e.g. an `AbortSignal.timeout(ms)` kept live until the body is
 * fully read — since this function's own protection has already ended by the
 * time body consumption starts.
 *
 * Composition rules:
 * - The caller's `init` is passed through unchanged except for `signal`, which
 *   is replaced by an internal composite signal.
 * - If the caller supplied `init.signal`, aborting THAT signal also aborts the
 *   request (the abort reason is propagated), and the resulting rejection is
 *   the caller's abort error, NOT a timeout error.
 * - Only our own timeout produces `error.code === FETCH_TIMEOUT_CODE`.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Chain the caller's signal (if any) into our controller so that either
  // source can abort the in-flight request.
  const callerSignal = init?.signal ?? undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(
        `Request timed out after ${timeoutMs}ms`,
      ) as Error & { code: string };
      timeoutError.code = FETCH_TIMEOUT_CODE;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}
