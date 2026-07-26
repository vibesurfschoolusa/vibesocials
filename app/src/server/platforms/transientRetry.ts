import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

/**
 * Should this publish-path failure be retried in-step?
 *
 * YES — the request provably did not commit on the platform:
 *  - HTTP 429 / 5xx responses (`assertOk` attaches `status`)
 *  - pre-response network failures (undici fetch rejects with TypeError)
 *
 * NO — everything else, deliberately:
 *  - FETCH_TIMEOUT: the platform may have received and committed the request;
 *    retrying risks a double post. (fetchWithTimeout's timer only covers
 *    connection + headers, but that is exactly the ambiguous window.)
 *  - 4xx (except 429): auth/validation — retrying cannot help.
 *  - token/reconnect error codes: terminal until the user reconnects.
 */
export function isTransientPublishError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: unknown; code?: unknown };
  if (err.code === FETCH_TIMEOUT_CODE) return false;
  if (typeof err.status === "number") {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

/** Backoff schedule between attempts: attempt1 --2s--> attempt2 --8s--> attempt3. */
const BACKOFF_MS = [2_000, 8_000] as const;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying ONLY transient failures (see isTransientPublishError),
 * up to 3 total attempts with 2s/8s backoff. Non-transient errors and the
 * final transient error are rethrown unchanged so `PostJobResult.errorCode`
 * / `errorMessage` keep their existing meaning.
 *
 * Lives OUTSIDE Inngest's retry machinery on purpose: `publishToAllPlatforms`
 * is `retries: 0` because function-level replays can double-post; this helper
 * bounds retries to the one platform call that provably failed.
 */
export async function withTransientRetries<T>(
  fn: () => Promise<T>,
  opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts?.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientPublishError(error) || attempt === BACKOFF_MS.length) {
        throw error;
      }
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw lastError; // unreachable; satisfies control-flow analysis
}
