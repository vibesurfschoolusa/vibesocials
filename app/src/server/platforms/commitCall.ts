import type { Platform } from "@prisma/client";

import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

import { PUBLISH_BUDGET_EXCEEDED_CODE } from "./publishBudget";
import { isNeverConnectedFetchError } from "./transientRetry";

// 2026-11-01 scale audit (jobs H6, Review Focus 5): the COMMIT call of a
// publish is the one request that makes the post exist on the platform (X
// tweet create, YouTube videos.insert, TikTok's final chunk PUT, Instagram
// media_publish, Facebook /photos, LinkedIn ugcPosts, GBP media create). Once
// it has been sent, a 5xx, a timeout or a dropped connection says nothing about
// whether the platform committed it, and re-running it would double-post.
//
// The rule: only a provably-unsent or a rejected outcome reaches the retry and
// failure paths we already had. Everything ambiguous is PUBLISH_UNCONFIRMED,
// which withTransientRetries never repeats (transientRetry.ts) and which the
// Activity card shows inline, before the Retry button.
//
//   outcome of the commit call            handling
//   5xx                                   PUBLISH_UNCONFIRMED
//   FETCH_TIMEOUT                         PUBLISH_UNCONFIRMED
//   post-connect network error            PUBLISH_UNCONFIRMED
//   PUBLISH_TIME_BUDGET_EXCEEDED          rethrown unchanged (thrown before sending)
//   never-connected fetch TypeError       rethrown unchanged (provably not sent)
//   429 and other 4xx                     returned: the caller classifies the
//                                         429 (rateLimited.ts) or fails as before

export type PublishUnconfirmedError = Error & { code: typeof PUBLISH_UNCONFIRMED_CODE };

/**
 * The error for a commit call whose outcome we cannot know. The message is the
 * shared user-facing one (no upstream text, no platform label: the Activity card
 * prefixes the label); `cause` keeps what we saw, for the server logs.
 */
export function publishUnconfirmedError(platform: Platform, cause?: unknown): PublishUnconfirmedError {
  console.error(`[${platform}] Commit call outcome unknown; reporting ${PUBLISH_UNCONFIRMED_CODE}`, {
    platform,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,
  });
  return Object.assign(new Error(PUBLISH_UNCONFIRMED_MESSAGE, { cause }), {
    code: PUBLISH_UNCONFIRMED_CODE,
  } as const);
}

/** Did this failure happen before anything could have reached the platform? */
function isProvablyUnsent(error: unknown): boolean {
  if (error instanceof TypeError && isNeverConnectedFetchError(error)) return true;
  // Thrown by budgetedTimeout()/publishBudgetExceededError() before the request
  // is built, so there is nothing for the platform to have committed.
  return (error as { code?: unknown } | null)?.code === PUBLISH_BUDGET_EXCEEDED_CODE;
}

/** The sent request got a 5xx: the platform may have committed it first. */
function serverErrorCause(response: Response): Error & { status: number } {
  return Object.assign(new Error(`Commit call answered HTTP ${response.status}`), {
    status: response.status,
  });
}

/**
 * Send a commit call and sort its outcome (see the table above). `send` makes
 * the request, typically `() => fetchWithTimeout(url, init, budgetedTimeout(...))`;
 * it is called exactly once, so build per-attempt state (signatures, body) before
 * calling this, and never wrap it in a retry loop.
 *
 * A returned response is not necessarily a success: it is a 2xx, or a 4xx the
 * platform rejected. Run `classifyRateLimit` and the client's own error handling
 * on it as before.
 */
export async function commitRequest(
  platform: Platform,
  send: () => Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (isProvablyUnsent(error)) throw error;
    // Already sorted by an inner commitRequest: keep its cause.
    if ((error as { code?: unknown } | null)?.code === PUBLISH_UNCONFIRMED_CODE) throw error;
    throw publishUnconfirmedError(platform, error);
  }

  if (response.status >= 500) {
    // The body is not used; release the connection instead of leaving it unread.
    void response.body?.cancel().catch(() => {});
    throw publishUnconfirmedError(platform, serverErrorCause(response));
  }
  return response;
}
