/**
 * R40 client-journey L2/L3: one "limit reached" view for every client link
 * (/c's choice, /v's list, /v's report). The network limit's 429 lasts its
 * clock hour, so a Try again pressed now fails again with the same sentence:
 * the page shows no button and one instruction, built from the answer's wait.
 * When the wait outlasts what the page is waiting for (the /c choice ends
 * after 15 minutes), reloading can't work, so the instruction names the step
 * that does.
 */

/** The routes' reason; their own 429 sentences start with it (tested). */
export const CLIENT_LINK_LIMIT_REASON = "Too many requests from this network in the last hour.";

function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The one instruction under a 429. `outlasts`: what the page waits for lives
 * `lifeSeconds` at most; a wait at least that long says to wait, then `then`.
 */
export function limitReachedSentence(
  waitSeconds: number | undefined,
  outlasts?: { lifeSeconds: number; then: string },
): string {
  if (!waitSeconds || waitSeconds <= 0) return `${CLIENT_LINK_LIMIT_REASON} Reload this page later.`;
  if (outlasts && waitSeconds >= outlasts.lifeSeconds) {
    return `${CLIENT_LINK_LIMIT_REASON} Wait ${minutesText(waitSeconds)}, then ${outlasts.then}`;
  }
  return `${CLIENT_LINK_LIMIT_REASON} Reload this page in ${minutesText(waitSeconds)}.`;
}

/** The wait a 429 names: the body's `retryAfterSeconds`, else the Retry-After header. */
export function limitWaitSeconds(response: Response, data: unknown): number | undefined {
  const fromBody = (data as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : undefined;
}
