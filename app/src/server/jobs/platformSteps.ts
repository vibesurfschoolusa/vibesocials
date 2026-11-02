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
 *
 * 2026-11-02 scale audit (jobs, chunked uploads): a platform step that uploaded
 * part of a large video and has more to do reports `continue` instead (it saved
 * its state first, uploadState.ts). The run then calls the same platform again in
 * a continuation step, after a durable sleep when the platform asked to wait.
 * Continuations and deferrals share one queue.
 */

/** Waits (and so extra attempts) allowed per result per run; the next limit gives up. */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Continuation steps (`<stepId>-c<n>`) allowed per result per run. The worst
 * planned uploads need about 20 (X at 0.25 MB/s: 103 segments) to 23 (LinkedIn:
 * 128 parts plus processing). The step after the 40th is not started: the
 * platform step fails the result UPLOAD_INCOMPLETE (inngest-functions.ts), and
 * the orchestrator below throws if a plan asks anyway. With 40 sleeps and the
 * rate-limit steps, 7 platforms x (40 + 40 + 6) stay under Inngest's 1,000
 * steps per run (https://www.inngest.com/docs/usage-limits/inngest).
 */
export const MAX_CONTINUATIONS_PER_RESULT = 40;

/**
 * A continuation that is due in less than this starts straight away, with no
 * `sleepUntil`: a durable sleep is a step of its own (the 1,000-step budget
 * above), and the next step's own start-up already takes about this long.
 */
export const MIN_CONTINUATION_SLEEP_MS = 1_000;

/**
 * The longest a continuation waits. A continuation is a poll interval (X's
 * `check_after_secs`, LinkedIn's or TikTok's processing), not a rate-limit
 * deferral: it records no `deferredUntil`, so the 2 h stuck-in_progress
 * reconciler would take a longer sleep for a dead run. 15 min is far above any
 * documented poll interval, and well below that window.
 */
export const MAX_CONTINUATION_WAIT_MS = 900_000;

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

/**
 * When a continuing platform is due and whether the run sleeps until then.
 * `resumeAt` is the epoch ms the client asked for (null: call again now), `now`
 * the end of the step that reported it. The instant is never in the past and at
 * most {@link MAX_CONTINUATION_WAIT_MS} away; the run sleeps only for a wait of
 * at least {@link MIN_CONTINUATION_SLEEP_MS}.
 */
export function resolveContinuation(
  resumeAt: number | null,
  now: number,
): { resumeAt: string; sleep: boolean } {
  const wanted = resumeAt !== null && Number.isFinite(resumeAt) ? resumeAt : now;
  const due = Math.min(Math.max(wanted, now), now + MAX_CONTINUATION_WAIT_MS);
  return { resumeAt: new Date(due).toISOString(), sleep: due - now >= MIN_CONTINUATION_SLEEP_MS };
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
 * free of tokens, email addresses and capability URLs). `deferred` carries the
 * ISO instant the run will wait for. `continue` carries the ISO instant the next
 * step is due (the end of this step when the platform can go on at once) and
 * whether the run sleeps until then (`sleep`) or starts it straight away.
 */
export type PlatformStepOutcome =
  | { platform: Platform; status: "success" | "failed" | "skipped"; error?: string }
  | { platform: Platform; status: "deferred"; retryAt: string }
  | { platform: Platform; status: "continue"; resumeAt: string; sleep: boolean };

/**
 * One platform's work for a run: its step id and what to do on attempt
 * `attempt` (0 = the first; n after the n-th rate-limit wait) in continuation
 * step `continuation` (0 = the first step; n after the n-th `continue`). The two
 * counters are independent and only grow.
 */
export interface PlatformStepPlan {
  platform: Platform;
  /** The step id of attempt 0: `publish-to-<platform>` / `retry-<platform>` (in-flight runs memoize these). */
  stepId: string;
  run: (attempt: number, continuation: number) => Promise<PlatformStepOutcome>;
}

/** When a waiting platform is next due: its deferral's `retryAt` or its continuation's `resumeAt`. */
function dueAt(outcome: PlatformStepOutcome): number | null {
  if (outcome.status === "deferred") return Date.parse(outcome.retryAt);
  if (outcome.status === "continue") return Date.parse(outcome.resumeAt);
  return null;
}

type PlatformStepTools = Pick<GetStepTools<typeof inngest>, "run" | "sleepUntil">;

/**
 * Run every platform's step, then wait out and re-run the ones that were rate
 * limited and carry on the ones that have more to upload. Returns each
 * platform's FINAL outcome, in plan order.
 *
 * - Pass one runs every plan once, in the order given, as `plan.stepId`.
 * - Then the waiting platforms go one at a time, the one due earliest first (plan
 *   order breaks a tie). A deferred platform is due at its `retryAt`, a
 *   continuing one at its `resumeAt`; both instants come from the memoized step
 *   outputs, so no clock is read here and the platforms of a run interleave.
 *   - Deferred: `step.sleepUntil` to `retryAt`, then the platform's step again.
 *     Attempt n is the step `${stepId}-rl${n}` after the sleep
 *     `${stepId}-wait-rl${n}`.
 *   - Continuing: when it asked to wait (`sleep`), `step.sleepUntil` to
 *     `resumeAt`, then the platform's step again. Continuation n is the step
 *     `${stepId}-c${n}` after the sleep `${stepId}-wait-c${n}`.
 *   Step ids are deterministic (no clock, no randomness), and attempt 0 keeps
 *   today's ids, so runs already in flight when this ships replay unchanged. The
 *   `-rl` and `-c` counters are independent and only grow, so an id never repeats.
 * - A platform that is limited or continues again goes back into the queue under
 *   its new instant. The plan's `run` stops reporting `deferred` once
 *   {@link resolveDeferral} gives up and stops reporting `continue` once
 *   {@link MAX_CONTINUATIONS_PER_RESULT} steps were used, so the loop ends.
 */
export async function runPlatformStepsWithDeferrals(
  step: PlatformStepTools,
  plans: PlatformStepPlan[],
): Promise<PlatformStepOutcome[]> {
  const outcomes: PlatformStepOutcome[] = [];
  /** Rate-limit waits used so far, per plan (the n of `-rl<n>`). */
  const attempts: number[] = [];
  /** Continuation steps used so far, per plan (the n of `-c<n>`). */
  const continuations: number[] = [];

  for (const plan of plans) {
    outcomes.push((await step.run(plan.stepId, () => plan.run(0, 0))) as PlatformStepOutcome);
    attempts.push(0);
    continuations.push(0);
  }

  for (;;) {
    let next = -1;
    let nextAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < outcomes.length; i += 1) {
      const at = dueAt(outcomes[i]);
      if (at === null) continue;
      if (next === -1 || at < nextAt) {
        next = i;
        nextAt = at;
      }
    }
    if (next === -1) return outcomes;

    const index = next;
    const plan = plans[index];
    const waiting = outcomes[index];

    if (waiting.status === "continue") {
      const continuation = continuations[index] + 1;
      if (continuation > MAX_CONTINUATIONS_PER_RESULT) {
        // A plan reports `continue` only while another step is still allowed.
        // Stop (and let the onFailure handler fail the pending result) rather
        // than loop toward Inngest's 1,000-step limit.
        throw new NonRetriableError(
          `${plan.platform} still has an upload to continue after ${MAX_CONTINUATIONS_PER_RESULT} continuation steps`,
        );
      }

      if (waiting.sleep) {
        await step.sleepUntil(`${plan.stepId}-wait-c${continuation}`, new Date(waiting.resumeAt));
      }
      continuations[index] = continuation;
      outcomes[index] = (await step.run(`${plan.stepId}-c${continuation}`, () =>
        plan.run(attempts[index], continuation),
      )) as PlatformStepOutcome;
      continue;
    }

    const deferred = waiting as Extract<PlatformStepOutcome, { status: "deferred" }>;
    const attempt = attempts[index] + 1;
    if (attempt > MAX_RATE_LIMIT_RETRIES) {
      // A plan reports `deferred` only while resolveDeferral still allows another
      // attempt. Stop (and let the onFailure handler fail the pending result)
      // rather than loop toward Inngest's 1,000-step limit.
      throw new NonRetriableError(
        `${plan.platform} is still deferred after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries`,
      );
    }

    await step.sleepUntil(`${plan.stepId}-wait-rl${attempt}`, new Date(deferred.retryAt));
    attempts[index] = attempt;
    outcomes[index] = (await step.run(`${plan.stepId}-rl${attempt}`, () =>
      plan.run(attempt, continuations[index]),
    )) as PlatformStepOutcome;
  }
}
