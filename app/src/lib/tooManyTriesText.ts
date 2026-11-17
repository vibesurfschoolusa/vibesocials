// The wait sentence of a refused try. In its own file, free of next/server,
// so pages build the same words from a 429's wait (R42 review).

/**
 * R42 pages-a L3: the sentence a refused try shows, built from the limit's own
 * wait. Pages show it word for word, and a wait can be up to an hour, so "slow
 * down" alone sent people back a minute later to be refused again. The wait is
 * rounded up to whole minutes, so trying again when it says never fails.
 * `then`: the step after the wait, for a page whose step is not "try again".
 */
export function tooManyTriesSentence(retryAfterSeconds: number | undefined, then = "try again"): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return `Too many tries. Wait a few minutes, then ${then}.`;
  }
  return `Too many tries. Wait ${waitText(retryAfterSeconds)}, then ${then}.`;
}

/**
 * R45 lead review: the one wording of a known wait ("Wait <this>"). Whole
 * minutes, rounded up, under an hour; from an hour, whole hours, rounded up
 * ("1 hour", as dailyLimitSentence says it), so acting when it says never fails.
 */
export function waitText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The wait a 429 names: the body's `retryAfterSeconds`, else the Retry-After header's seconds. */
export function waitSecondsOf(data: unknown, retryAfterHeader?: string | number | null): number | undefined {
  const fromBody = (data as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const header = Number(retryAfterHeader ?? NaN);
  return Number.isFinite(header) && header > 0 ? header : undefined;
}
