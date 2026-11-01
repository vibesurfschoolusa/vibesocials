/**
 * Per-step time budget for publishing to ONE platform (2026-11-01 audit,
 * Task 4 items 7 + 10).
 *
 * Vercel caps the Inngest route at 300s per invocation (app/vercel.json), and
 * every `step.run("publish-to-<platform>")` / `retry-<platform>` runs in its
 * own invocation. A step killed at that cap fails the whole `retries: 0` run:
 * the platforms after it are never attempted (the onFailure handler then marks
 * them PUBLISH_INTERRUPTED). So one platform's publish — in-step transient
 * retries included — must end comfortably inside the cap, with time left to
 * record its PostJobResult.
 *
 * publishToPlatform stamps ONE deadline (`publishDeadline()`) before the
 * step's first attempt and threads it through `PublishContext.deadline`.
 * withTransientRetries and the long-running clients (X, TikTok) bound every
 * phase that can START late — a request, a poll wait, a retry — by the time
 * actually left. After the deadline only the PostJobResult write runs, so a
 * step ends within ~PUBLISH_STEP_BUDGET_MS + one DB write (< 240s).
 */

/** How long one platform step may spend talking to the platform. */
export const PUBLISH_STEP_BUDGET_MS = 225_000;

/** A request is not started with less than this left — it could only time out. */
export const MIN_REQUEST_WINDOW_MS = 5_000;

/** Error code when a request was refused because the step's budget is spent. */
export const PUBLISH_BUDGET_EXCEEDED_CODE = "PUBLISH_TIME_BUDGET_EXCEEDED";

/** The deadline (epoch ms) for a platform step starting at `now`. */
export function publishDeadline(now: number = Date.now()): number {
  return now + PUBLISH_STEP_BUDGET_MS;
}

/** Milliseconds left before `deadline` (negative once past); unbounded without one. */
export function remainingMs(deadline: number | undefined, now: number = Date.now()): number {
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now;
}

/**
 * The step budget is spent. Thrown only BEFORE a request is sent, so that
 * request cannot have published anything; callers place budget checks where a
 * retry is safe (nothing committed yet, or an incomplete upload the platform
 * discards).
 */
export function publishBudgetExceededError(): Error & { code: string } {
  const error = new Error(
    "Publishing ran out of time before it finished. Please retry.",
  ) as Error & { code: string };
  error.code = PUBLISH_BUDGET_EXCEEDED_CODE;
  return error;
}

/**
 * A request's timeout clamped to the step's remaining budget, so a request
 * started late still ends by the deadline. Throws
 * {@link publishBudgetExceededError} instead when less than
 * {@link MIN_REQUEST_WINDOW_MS} is left. Without a deadline, `timeoutMs` as is.
 */
export function budgetedTimeout(
  timeoutMs: number,
  deadline: number | undefined,
  now: number = Date.now(),
): number {
  const left = remainingMs(deadline, now);
  if (left < MIN_REQUEST_WINDOW_MS) throw publishBudgetExceededError();
  return Math.min(timeoutMs, left);
}
