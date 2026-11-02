import { NonRetriableError, type GetStepTools } from "inngest";
import type { Platform } from "@prisma/client";

import type { inngest } from "@/lib/inngest";
import { platformLabel } from "@/lib/platforms";
import { DAILY_LIMIT_CODE } from "@/lib/resultDeferral";
import {
  RATE_LIMITED_CODE,
  type RateLimitedError,
  type RateLimitKind,
} from "@/server/platforms/rateLimited";

/**
 * 2026-11-01 scale audit (platform limits): a platform that answers with a rate
 * limit or quota refusal is waited out, not failed. The platform step hands its
 * claim back (resultClaim.ts `releaseClaimForDeferral`) and reports `deferred`;
 * the RUN then sleeps with `step.sleepUntil`, which frees the concurrency slot
 * (https://www.inngest.com/docs/guides/concurrency), and runs that platform's
 * step again. The platforms that are not limited publish first, so a sleeping
 * YouTube never delays LinkedIn.
 */

/** Waits (and so extra attempts) allowed per result per run; the next limit gives up. */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Waits between attempts when the platform gave no usable reset time (attempt 0,
 * 1, 2). Google Business Profile's documented exponential backoff; none of the
 * other platforms documents a `Retry-After` (plan U5). Source:
 * https://developers.google.com/my-business/content/limits
 */
export const RATE_LIMIT_BACKOFF_MS = [60_000, 900_000, 3_600_000] as const;

/** A hint that is nearly (or already) due still waits this long: a bare retry would only be limited again. */
export const MIN_RATE_LIMIT_WAIT_MS = 30_000;

/**
 * The longest wait before giving up: 26 h (2026-11-01 scale audit, ruling R23).
 * `sleepUntil` itself allows a year (https://www.inngest.com/docs/usage-limits/inngest),
 * but a result that is still `pending` after a day or so is better failed, with
 * a "retry later" the user can act on, than left to sit. It is not 24 h because
 * YouTube's quota resets at the next midnight Pacific (plus the 5 min grace),
 * which is up to 25 h 5 min away on the fall-back day: a 24 h cap would fail the
 * whole overnight backlog of YouTube posts that day instead of waiting for the
 * reset. 26 h leaves an hour of slack over that.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 93_600_000;

/**
 * When a limited platform should be tried again: the platform's own `retryAt`
 * when it gave one (never sooner than {@link MIN_RATE_LIMIT_WAIT_MS}), else the
 * backoff step for `attempt`; or `giveUp`.
 *
 * `attempt` is the attempt that was just limited (0 for the first). Gives up
 * after {@link MAX_RATE_LIMIT_RETRIES} waits, so the 4th consecutive limit
 * (attempt 3) ends the result, and when the platform asks to wait more than
 * {@link MAX_RATE_LIMIT_WAIT_MS} (26 h).
 */
export function resolveDeferral(
  err: RateLimitedError,
  attempt: number,
  now: number,
): { retryAt: number } | { giveUp: true } {
  if (attempt >= MAX_RATE_LIMIT_RETRIES) return { giveUp: true };

  const hint = err.retryAt;
  if (hint !== null && Number.isFinite(hint)) {
    if (hint - now > MAX_RATE_LIMIT_WAIT_MS) return { giveUp: true };
    return { retryAt: Math.max(hint, now + MIN_RATE_LIMIT_WAIT_MS) };
  }

  const step = Math.min(Math.max(Math.trunc(attempt), 0), RATE_LIMIT_BACKOFF_MS.length - 1);
  return { retryAt: now + RATE_LIMIT_BACKOFF_MS[step] };
}

/** `PostJobResult.errorCode` for a limit of this kind: only a plain rate limit is RATE_LIMITED. */
export function deferralErrorCode(kind: RateLimitKind): typeof RATE_LIMITED_CODE | typeof DAILY_LIMIT_CODE {
  return kind === "rate_limited" ? RATE_LIMITED_CODE : DAILY_LIMIT_CODE;
}

/** What a result is failed with when the waits ran out (or the platform asked for more than a day). */
export function giveUpFailure(
  platform: Platform,
  kind: RateLimitKind,
): { errorCode: string; errorMessage: string } {
  const label = platformLabel(platform);
  return kind === "rate_limited"
    ? {
        errorCode: RATE_LIMITED_CODE,
        errorMessage: `${label} kept rate-limiting this post. Retry this platform later.`,
      }
    : {
        errorCode: DAILY_LIMIT_CODE,
        errorMessage: `${label}'s daily limit is still reached. Retry this platform later.`,
      };
}

/**
 * What a platform step reports for its platform (step output, so JSON-safe and
 * free of tokens and email addresses). `deferred` carries the ISO instant the
 * run will wait for.
 */
export type PlatformStepOutcome =
  | { platform: Platform; status: "success" | "failed" | "skipped"; error?: string }
  | { platform: Platform; status: "deferred"; retryAt: string };

/** One platform's work for a run: its step id and what to do on attempt `attempt` (0 = the first). */
export interface PlatformStepPlan {
  platform: Platform;
  /** The step id of attempt 0: `publish-to-<platform>` / `retry-<platform>` (in-flight runs memoize these). */
  stepId: string;
  run: (attempt: number) => Promise<PlatformStepOutcome>;
}

type PlatformStepTools = Pick<GetStepTools<typeof inngest>, "run" | "sleepUntil">;

/**
 * Run every platform's step, then wait out and re-run the ones that were rate
 * limited. Returns each platform's FINAL outcome, in plan order.
 *
 * - Pass one runs every plan once, in the order given, as `plan.stepId`.
 * - Then the deferred platforms are retried one at a time, earliest `retryAt`
 *   first (plan order breaks a tie): `step.sleepUntil` to that instant, then the
 *   platform's step again. Attempt n is the step `${stepId}-rl${n}` after the
 *   sleep `${stepId}-wait-rl${n}`. Step ids are deterministic (no clock, no
 *   randomness), and attempt 0 keeps today's ids, so runs already in flight when
 *   this ships replay unchanged.
 * - A retried platform that is limited again goes back into the queue under its
 *   new `retryAt`. The plan's `run` stops reporting `deferred` once
 *   {@link resolveDeferral} gives up, so the loop ends.
 */
export async function runPlatformStepsWithDeferrals(
  step: PlatformStepTools,
  plans: PlatformStepPlan[],
): Promise<PlatformStepOutcome[]> {
  const outcomes: PlatformStepOutcome[] = [];
  const attempts: number[] = [];

  for (const plan of plans) {
    outcomes.push((await step.run(plan.stepId, () => plan.run(0))) as PlatformStepOutcome);
    attempts.push(0);
  }

  for (;;) {
    let next = -1;
    let nextAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < outcomes.length; i += 1) {
      const outcome = outcomes[i];
      if (outcome.status !== "deferred") continue;
      const at = Date.parse(outcome.retryAt);
      if (next === -1 || at < nextAt) {
        next = i;
        nextAt = at;
      }
    }
    if (next === -1) return outcomes;

    const plan = plans[next];
    const deferred = outcomes[next] as Extract<PlatformStepOutcome, { status: "deferred" }>;
    const attempt = attempts[next] + 1;
    if (attempt > MAX_RATE_LIMIT_RETRIES) {
      // A plan reports `deferred` only while resolveDeferral still allows another
      // attempt. Stop (and let the onFailure handler fail the pending result)
      // rather than loop toward Inngest's 1,000-step limit.
      throw new NonRetriableError(
        `${plan.platform} is still deferred after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries`,
      );
    }

    await step.sleepUntil(`${plan.stepId}-wait-rl${attempt}`, new Date(deferred.retryAt));
    attempts[next] = attempt;
    outcomes[next] = (await step.run(`${plan.stepId}-rl${attempt}`, () =>
      plan.run(attempt),
    )) as PlatformStepOutcome;
  }
}
