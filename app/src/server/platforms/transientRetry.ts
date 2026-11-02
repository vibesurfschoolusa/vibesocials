import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { remainingMs } from "./publishBudget";
import { RATE_LIMITED_CODE } from "./rateLimited";

/**
 * `cause.code`s of a Node fetch failure that PROVE the connection was never
 * established — so the platform cannot have received, let alone committed,
 * the request: connection refused, DNS failure (permanent / temporary),
 * network or host unreachable, and undici's connect-phase timeout.
 */
const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Is this a Node fetch network failure (`TypeError("fetch failed")`) whose
 * `cause.code` proves the request never left this machine? A multi-address
 * connect failure surfaces as an `AggregateError` cause that carries the code
 * too. Any other TypeError — a connection reset mid-request, a socket closed
 * after the body was sent, a programming error — is NOT provable.
 */
function isNeverConnectedFetchError(error: TypeError): boolean {
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && NEVER_CONNECTED_CODES.has(code);
}

/**
 * Should this publish-path failure be retried in-step?
 *
 * YES — the request provably did not commit on the platform:
 *  - HTTP 429 / 5xx responses (`assertOk` attaches `status`). A platform API
 *    429 is classified first and becomes RATE_LIMITED (below); a 429 from a
 *    call that is not classified, such as a token endpoint, still lands here.
 *  - network failures that never connected (see NEVER_CONNECTED_CODES)
 *
 * NO — everything else, deliberately:
 *  - other network failures (2026-11-01 audit): undici rejects with the same
 *    `TypeError("fetch failed")` when a connection drops AFTER the platform
 *    received the request (ECONNRESET, UND_ERR_SOCKET, ...) — it may already
 *    have published, so re-running the whole publish could double-post.
 *  - FETCH_TIMEOUT: the platform may have received and committed the request;
 *    retrying risks a double post. (fetchWithTimeout's timer only covers
 *    connection + headers, but that is exactly the ambiguous window.)
 *  - RATE_LIMITED (2026-11-01 scale audit, platform limits): a classified 429 /
 *    quota response (rateLimited.ts) is waited out until its `retryAt`, not
 *    hammered again 2s and 8s later — which would only extend the limit.
 *  - 4xx (except 429): auth/validation — retrying cannot help.
 *  - token/reconnect error codes: terminal until the user reconnects.
 */
export function isTransientPublishError(error: unknown): boolean {
  if (error instanceof TypeError) return isNeverConnectedFetchError(error);
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: unknown; code?: unknown };
  if (err.code === FETCH_TIMEOUT_CODE) return false;
  // Checked before `status`: a RateLimitedError must never be retried in-step,
  // whatever other fields it ends up carrying.
  if (err.code === RATE_LIMITED_CODE) return false;
  if (typeof err.status === "number") {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

/** Backoff schedule between attempts: attempt1 --2s--> attempt2 --8s--> attempt3. */
const BACKOFF_MS = [2_000, 8_000] as const;

/**
 * A retry re-runs the WHOLE platform publish (download, upload, processing
 * poll), so it is only started when at least this much of the step's budget is
 * left after the backoff (2026-11-01 audit). A shorter retry would mostly hit
 * the deadline and replace the real error with a budget/timeout one.
 */
export const MIN_RETRY_WINDOW_MS = 60_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying ONLY transient failures (see isTransientPublishError),
 * up to 3 total attempts with 2s/8s backoff. Non-transient errors and the
 * final transient error are rethrown unchanged so `PostJobResult.errorCode`
 * / `errorMessage` keep their existing meaning.
 *
 * With a step `deadline` (publishBudget.ts), a retry is only started when its
 * backoff plus {@link MIN_RETRY_WINDOW_MS} still fits before it; otherwise the
 * current error is rethrown. Each retried attempt is itself bounded by the same
 * deadline (the clients clamp to it), so retries never stretch a step past it.
 *
 * Lives OUTSIDE Inngest's retry machinery on purpose: the publish functions'
 * `retries: 3` may re-run a step, but a re-run platform step meets its own
 * claim and never calls the platform again (resultClaim.ts), so a function-level
 * replay cannot re-send the post; this helper bounds retries to the one platform
 * call that provably failed.
 */
export async function withTransientRetries<T>(
  fn: () => Promise<T>,
  opts?: {
    sleep?: (ms: number) => Promise<void>;
    /** Epoch ms by which the step must be done (see publishBudget.ts). */
    deadline?: number;
    /** Clock seam for tests. */
    now?: () => number;
  },
): Promise<T> {
  const sleep = opts?.sleep ?? realSleep;
  const now = opts?.now ?? Date.now;
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientPublishError(error) || attempt === BACKOFF_MS.length) {
        throw error;
      }
      const backoff = BACKOFF_MS[attempt];
      if (remainingMs(opts?.deadline, now()) < backoff + MIN_RETRY_WINDOW_MS) {
        throw error;
      }
      await sleep(backoff);
    }
  }
  throw lastError; // unreachable; satisfies control-flow analysis
}
