import { Prisma, type PostJobResultStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * 2026-11-01 scale audit (jobs H6): the per-result publish claim.
 *
 * Posting is not idempotent, and the publish functions can see the same result
 * from two runs at once (a duplicate event, a retry overlapping a late original
 * run) and — once Inngest retries a platform step — from the same run twice.
 * Every `publish-to-<platform>` / `retry-<platform>` step therefore claims its
 * PostJobResult with ONE conditional write before it touches the platform, and
 * writes the outcome only while it still holds that claim.
 *
 * `PostJobResult.claimRunId` is the Inngest `runId` of the step about to call
 * the platform. A claim is only ever held inside one step (<= 300 s), so a
 * `pending` row that still has one afterwards lost its run mid-call.
 *
 * 2026-11-02 scale audit (jobs, chunked uploads): an upload that spans several
 * steps keeps that rule. Each step claims the result at its start and every
 * `continue` releases the claim (releaseClaimForContinuation) before the step
 * ends; the saved upload state (uploadState.ts) is what carries it over.
 */

/** What {@link claimResult} found. */
export type ClaimOutcome =
  /** This call took the claim: go ahead and publish. */
  | "claimed"
  /** The result is gone, finished, or failed meanwhile: nothing to publish. */
  | "not_pending"
  /** Another run claimed it first (and may be calling the platform right now): skip. */
  | "held_by_other_run"
  /**
   * THIS run claimed it in an earlier attempt of the step that never recorded an
   * outcome. The platform call may have gone through, so do NOT make it again:
   * record PUBLISH_UNCONFIRMED.
   */
  | "held_by_this_run";

/** Why a result is waiting (`PostJobResult.errorCode` while it is deferred). */
export type DeferralErrorCode = "RATE_LIMITED" | "DAILY_LIMIT";

/** A platform's final outcome, as written to its PostJobResult row. */
export type FinalResultData =
  | { status: "success"; externalPostId: string | null; externalPostUrl?: string | null; note?: string }
  | { status: "failed"; errorCode: string; errorMessage: string };

/**
 * Claim a still-`pending`, unclaimed result for `runId`. Exactly one concurrent
 * caller gets `"claimed"`; every other outcome means do not call the platform.
 * When the write matches nothing, the row is read back only to say why.
 *
 * Taking the claim ends a deferral (2026-11-01 scale audit, platform limits): a
 * result the run put to sleep with {@link releaseClaimForDeferral} is `pending`
 * and unclaimed, so this same write picks it up again, and clears the wait
 * (`deferredUntil`) and the RATE_LIMITED / DAILY_LIMIT code it carried. A first
 * claim has nothing to clear (a re-queued retry cleared them already), so the
 * extra columns are no-ops there.
 */
export async function claimResult(
  resultId: string,
  runId: string,
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  const { count } = await prisma.postJobResult.updateMany({
    where: { id: resultId, status: "pending", claimRunId: null },
    data: {
      claimRunId: runId,
      claimedAt: now,
      deferredUntil: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (count === 1) return "claimed";

  const current = await prisma.postJobResult.findUnique({
    where: { id: resultId },
    select: { status: true, claimRunId: true },
  });
  if (current?.status !== "pending") return "not_pending";
  // A `pending` row with no holder was just re-queued by the retry route (which
  // clears the claim); that retry run will claim it, so this run must skip.
  return current.claimRunId === runId ? "held_by_this_run" : "held_by_other_run";
}

/**
 * Write a claimed result's final outcome AND, in the same nested write, bump the
 * parent PostJob's `updatedAt` (Task 4 item 6). That timestamp is the heartbeat
 * the stale sweep (`stalePostJobSweep`, 6h) and the stuck-in_progress reconciler
 * (`reconcileStuckInProgressJobs`, 2h) judge progress by, so a slow-but-alive run
 * must keep touching its job.
 *
 * The write matches only while `runId` still holds the claim:
 * - a failure needs the result to be `pending`;
 * - a confirmed success also overwrites a `failed` row (ruling R17). Anything
 *   that failed the row while this run still held the claim - the reconciler's
 *   or an onFailure handler's PUBLISH_UNCONFIRMED mark (U7: a timed-out
 *   invocation can keep running), the retry route reverting an enqueue it
 *   thought failed, old code reverting rows during version skew - was written
 *   without knowing the post went out, and the platform's confirmation is the
 *   truth. This is safe because a new attempt has to clear (retry route) or take
 *   (a fresh claim) the claim before it can act, which ends this run's write.
 *
 * Either outcome also clears the saved upload state (`uploadState`, a chunked
 * upload's progress and sealed capability URLs): the upload is over, and a failed
 * one starts from scratch when the user retries.
 *
 * Returns false (and logs) when the claim is no longer held — the result was
 * reset, failed or finalized by someone else — instead of throwing: a thrown
 * error would only make the step fail again. A lost FAILURE is a warning. A lost
 * SUCCESS is an error (final review F6, M1): the post is live but the row does
 * not say so (it may read PUBLISH_UNCONFIRMED), and that log line, with the
 * provider's post id, is the only trace to reconcile it by.
 */
export async function finalizeClaimedResult(
  resultId: string,
  runId: string,
  data: FinalResultData,
): Promise<boolean> {
  const where =
    data.status === "success"
      ? { id: resultId, claimRunId: runId, status: { in: ["pending", "failed"] satisfies PostJobResultStatus[] } }
      : { id: resultId, claimRunId: runId, status: "pending" as const };

  try {
    await prisma.postJobResult.update({
      where,
      data: {
        ...data,
        uploadState: Prisma.DbNull,
        postJob: { update: { updatedAt: new Date() } },
      },
    });
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) {
      if (data.status === "success") {
        await logLostSuccess(resultId, runId, data.externalPostId);
      } else {
        logger.warn("[Inngest] Result not written: this run no longer holds its claim", {
          resultId,
          runId,
          outcome: data.status,
        });
      }
      return false;
    }
    throw error;
  }
}

/**
 * Log, at error level, a confirmed success that could not be recorded because the
 * claim was gone (final review F6). The caller's `externalPostId` is the key to
 * reconcile the post by; the platform and job id are read back best-effort (the
 * write that just failed gives no row), and a failed read must not lose the line.
 * Ids only: no tokens, no emails, no captions.
 */
async function logLostSuccess(
  resultId: string,
  runId: string,
  externalPostId: string | null,
): Promise<void> {
  let platform: string | null = null;
  let postJobId: string | null = null;
  try {
    const row = await prisma.postJobResult.findUnique({
      where: { id: resultId },
      select: { platform: true, postJobId: true },
    });
    platform = row?.platform ?? null;
    postJobId = row?.postJobId ?? null;
  } catch {
    // Best effort: the line below still carries the result id and the post id.
  }
  logger.error("[Inngest] Post is live but its result was not recorded: this run no longer holds its claim", {
    resultId,
    postJobId,
    platform,
    runId,
    externalPostId,
    outcome: "success",
  });
}

/**
 * Hand a claimed result back while its platform is rate-limited
 * (2026-11-01 scale audit, platform limits). The result stays `pending`, holds
 * no claim, and records until when the run will wait (`deferredUntil`) and why
 * (`errorCode` RATE_LIMITED or DAILY_LIMIT, no message: the card words it from
 * the code). The run sleeps and claims it again ({@link claimResult}).
 *
 * Releasing the claim, not keeping it, is what makes the wait safe: a claim
 * means "the platform call may be in flight", so a claimed row that outlives
 * its step is failed PUBLISH_UNCONFIRMED by the reconciler / onFailure handler.
 * A deferred row is provably not mid-call, and those paths already treat an
 * unclaimed `pending` row as "never reached the platform".
 *
 * Like the finalize it bumps the job heartbeat in the same write, and matches
 * only while `runId` still holds the claim on a `pending` result. Returns false
 * (and logs a warning) when it no longer does - the result was failed or
 * finished by someone else - so the caller stops waiting for it. It keeps
 * `uploadState`: an upload that was rate-limited between two chunks resumes from
 * its saved state.
 */
export async function releaseClaimForDeferral(
  resultId: string,
  runId: string,
  deferral: { until: Date; errorCode: DeferralErrorCode },
): Promise<boolean> {
  try {
    await prisma.postJobResult.update({
      where: { id: resultId, claimRunId: runId, status: "pending" },
      data: {
        claimRunId: null,
        claimedAt: null,
        deferredUntil: deferral.until,
        errorCode: deferral.errorCode,
        errorMessage: null,
        postJob: { update: { updatedAt: new Date() } },
      },
    });
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) {
      logger.warn("[Inngest] Deferral not recorded: this run no longer holds its claim", {
        resultId,
        runId,
        errorCode: deferral.errorCode,
      });
      return false;
    }
    throw error;
  }
}

/**
 * Hand a claimed result back between two steps of one chunked upload
 * (2026-11-02 scale audit, jobs). The client made progress and saved its state
 * (uploadState.ts); the run calls the platform step again - after a durable
 * sleep when the platform asked to wait - and that step claims the result anew
 * ({@link claimResult}).
 *
 * One write clears the claim and bumps the job heartbeat. That is all: no
 * `deferredUntil` and no `errorCode`, so the Activity card shows an ordinary
 * "publishing" result and not rate-limit copy, and the saved upload state is kept.
 * The claim must not outlive the step for the same reason a deferral's must not:
 * a claimed row that outlives its step is failed PUBLISH_UNCONFIRMED. An unclaimed
 * `pending` one between two steps provably holds no post, because the commit call
 * and the work after it always run inside one claimed step.
 *
 * Matches only while `runId` still holds the claim on a `pending` result. Returns
 * false (and logs a warning) when it no longer does - the result was failed or
 * finished by someone else - so the caller stops continuing it.
 */
export async function releaseClaimForContinuation(
  resultId: string,
  runId: string,
): Promise<boolean> {
  try {
    await prisma.postJobResult.update({
      where: { id: resultId, claimRunId: runId, status: "pending" },
      data: {
        claimRunId: null,
        claimedAt: null,
        postJob: { update: { updatedAt: new Date() } },
      },
    });
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) {
      logger.warn("[Inngest] Continuation not recorded: this run no longer holds its claim", {
        resultId,
        runId,
      });
      return false;
    }
    throw error;
  }
}

/** Prisma's "an operation failed because it depends on a record that was not found". */
function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}
