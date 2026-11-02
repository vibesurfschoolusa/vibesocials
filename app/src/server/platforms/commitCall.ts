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
//   2xx, body unreadable / not parseable  PUBLISH_UNCONFIRMED (readCommitBody:
//                                         the platform answered "created")
//   2xx, parsed body without the post id  PUBLISH_UNCONFIRMED (requireCommitId,
//                                         2026-11-02 scale audit R30)

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

/**
 * Read the success body of a 2xx commit response (final review F4, I2).
 *
 * The platform has already said "created", so the post may be live. If the body
 * then cannot be read (the connection drops mid-body, a gateway answers 200 with
 * HTML) or parsed, that is not a failure we can retry: a plain error would end in
 * "failed, please retry" and a second post. Any error here is therefore
 * PUBLISH_UNCONFIRMED, with the read or parse error kept as the `cause`.
 *
 * Use it only for the commit call's success body. A missing field in a body that
 * did parse is the caller's own check, as before.
 */
export async function readCommitBody<T>(
  platform: Platform,
  res: Response,
  parse: "json" | "text",
): Promise<T> {
  try {
    return (parse === "json" ? await res.json() : await res.text()) as T;
  } catch (error) {
    throw publishUnconfirmedError(platform, error);
  }
}

/**
 * 2026-11-02 scale audit (jobs, R30): the id a client returns as `externalPostId`,
 * read from the parsed body of a 2xx commit response.
 *
 * The platform said "created" but did not tell us which post, so the post may be
 * live and the job must not offer a blind retry (a second post): that is
 * PUBLISH_UNCONFIRMED, with a `cause` naming the missing `field`. Returns the id
 * when it is a non-empty string.
 */
export function requireCommitId(platform: Platform, value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw publishUnconfirmedError(platform, new Error(`2xx commit body without ${field}`));
}
