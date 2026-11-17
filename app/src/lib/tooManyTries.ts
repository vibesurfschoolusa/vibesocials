import { NextResponse } from "next/server";

import { limitUncheckedResponse } from "./limitUnchecked";
import type { RateLimitResult } from "./rateLimit";
import { tooManyTriesSentence } from "./tooManyTriesText";

export { tooManyTriesSentence };

/**
 * The 429 for a refused checkRateLimit / consumeFixedWindow result: the wait
 * sentence, its seconds and a Retry-After header. A store that couldn't be
 * read (`unavailable`) reached no limit, so it keeps its own couldn't-check
 * answer (R38 new-customer L1) and is never told to wait.
 * `reason`: a sentence that goes before the wait, for a limit whose cause the
 * person can't guess (R43 new-customer L2: sign-ups are counted per network).
 */
export function tooManyTriesResponse(
  limit: Pick<RateLimitResult, "retryAfterSeconds" | "unavailable">,
  reason?: string,
): NextResponse {
  if (limit.unavailable) return limitUncheckedResponse();
  const { retryAfterSeconds } = limit;
  const sentence = tooManyTriesSentence(retryAfterSeconds);
  return NextResponse.json(
    { error: reason ? `${reason} ${sentence}` : sentence, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}
