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
 * headers phase ONLY. The internal timer is cleared in a `finally` that runs
 * as soon as the underlying `fetch()` call settles, i.e. once headers
 * arrive — BEFORE the response body is read. Consuming the body afterward
 * (`res.json()`, `res.text()`, `res.arrayBuffer()`, streaming `res.body`,
 * etc.) is NOT bounded by `timeoutMs`.
 *
 * Composition rules:
 * - The caller's `init` is passed through unchanged except for `signal`: the
 *   request is actually driven by `AbortSignal.any([init.signal,
 *   <our internal timeout controller's signal>])` when the caller supplies a
 *   signal (just our own controller's signal otherwise). `AbortSignal.any`
 *   keeps that composite wired to BOTH sources for the fetch's entire
 *   lifetime, not merely until headers arrive — so a caller-supplied
 *   `init.signal` genuinely bounds the ENTIRE request, including body
 *   streaming, even after our own `timeoutMs` protection has lapsed.
 * - Callers that read large/slow bodies (e.g. a future `downloadToBuffer`,
 *   media downloads) SHOULD pass a whole-transfer bound as `init.signal` —
 *   e.g. `AbortSignal.timeout(totalMs)` — to cover body consumption, since
 *   this function's own `timeoutMs` stops protecting once headers arrive.
 * - Aborting the caller's `init.signal` — before headers, after headers while
 *   the body is being read, or even already-aborted at call time — surfaces
 *   as the caller's own abort error, NOT a timeout error.
 * - Only our own `timeoutMs` expiring produces `error.code === FETCH_TIMEOUT_CODE`.
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

  // Compose the caller's signal (if any) with our own timeout controller so
  // either source can abort. Unlike manual add/removeEventListener
  // forwarding, AbortSignal.any keeps the composite genuinely wired to the
  // caller's signal for the fetch's entire lifetime — including body
  // streaming after we clear our own timer at headers.
  const callerSignal = init?.signal ?? undefined;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;

  try {
    return await fetch(url, { ...init, signal });
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
  }
}
