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
 */
export function tooManyTriesResponse(limit: Pick<RateLimitResult, "retryAfterSeconds" | "unavailable">): NextResponse {
  if (limit.unavailable) return limitUncheckedResponse();
  const { retryAfterSeconds } = limit;
  return NextResponse.json(
    { error: tooManyTriesSentence(retryAfterSeconds), retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}
