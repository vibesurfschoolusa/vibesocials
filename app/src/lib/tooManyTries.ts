import { NextResponse } from "next/server";

import { limitUncheckedResponse } from "./limitUnchecked";
import type { RateLimitResult } from "./rateLimit";

/**
 * R42 pages-a L3: the sentence a refused try shows, built from the limit's own
 * wait. Pages show it word for word, and a wait can be up to an hour, so "slow
 * down" alone sent people back a minute later to be refused again. The wait is
 * rounded up to whole minutes, so trying again when it says never fails.
 */
export function tooManyTriesSentence(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return "Too many tries. Wait a few minutes, then try again.";
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes <= 1
    ? "Too many tries. Wait a minute, then try again."
    : `Too many tries. Wait ${minutes} minutes, then try again.`;
}

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
