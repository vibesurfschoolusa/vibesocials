import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PUBLISH_UNCONFIRMED_CODE } from "@/lib/publishOutcomes";

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

/** A platform's final outcome, as written to its PostJobResult row. */
export type FinalResultData =
  | { status: "success"; externalPostId: string | null }
  | { status: "failed"; errorCode: string; errorMessage: string };

/**
 * Claim a still-`pending`, unclaimed result for `runId`. Exactly one concurrent
 * caller gets `"claimed"`; every other outcome means do not call the platform.
 * When the write matches nothing, the row is read back only to say why.
 */
export async function claimResult(
  resultId: string,
  runId: string,
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  const { count } = await prisma.postJobResult.updateMany({
    where: { id: resultId, status: "pending", claimRunId: null },
    data: { claimRunId: runId, claimedAt: now },
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
 * - a success also replaces this run's own PUBLISH_UNCONFIRMED mark (U7): a
 *   timed-out invocation can keep running after the reconciler or an onFailure
 *   handler marked its result unconfirmed, and once the platform confirms the
 *   post the truth should replace "may already be live".
 *
 * Returns false (and logs a warning) when the claim is no longer held — the
 * result was reset, failed or finalized by someone else — instead of throwing:
 * a thrown error would only make the step fail again.
 */
export async function finalizeClaimedResult(
  resultId: string,
  runId: string,
  data: FinalResultData,
): Promise<boolean> {
  const where =
    data.status === "success"
      ? {
          id: resultId,
          claimRunId: runId,
          OR: [
            { status: "pending" as const },
            { status: "failed" as const, errorCode: PUBLISH_UNCONFIRMED_CODE },
          ],
        }
      : { id: resultId, claimRunId: runId, status: "pending" as const };

  try {
    await prisma.postJobResult.update({
      where,
      data: { ...data, postJob: { update: { updatedAt: new Date() } } },
    });
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) {
      logger.warn("[Inngest] Result not written: this run no longer holds its claim", {
        resultId,
        runId,
        outcome: data.status,
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
