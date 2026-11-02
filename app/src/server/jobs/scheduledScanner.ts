import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";
import {
  buildPublishEvent,
  prepareDeferredPostJobDispatch,
  type PublishEvent,
} from "@/server/jobs/posting";

/**
 * Roadmap Phase 5 — DB-backed cron due-scanner claim logic (§6.2).
 *
 * The category-defining scheduler is a DB source of truth + a cron that claims
 * due jobs, NOT a weeks-long `step.sleepUntil` (which is a function-versioning
 * landmine and makes cancel/edit a run-teardown race). Extracted from the
 * Inngest function so the atomic-claim logic is unit-testable with a mocked
 * prisma, mirroring the route-test convention.
 */

/**
 * Max due jobs claimed per scan; the every-minute cadence drains any backlog.
 *
 * 2026-11-01 scale audit (jobs H6): 1000, up from 100, so a 500-post burst is
 * claimed by ONE tick. The old two-steps-per-job dispatch made that unaffordable
 * (2,002 steps against Inngest's 1,000-step run limit,
 * https://www.inngest.com/docs/usage-limits/inngest); the scanner now materializes
 * and sends in chunks of {@link MATERIALIZE_CHUNK_SIZE}, at most 2 + 3 x 20 steps.
 */
export const DUE_SCAN_BATCH = 1000;

/**
 * Claimed jobs materialized per `materialize-batch-<i>` step, and so the events
 * per `dispatch-batch-<i>` send. 2026-11-01 scale audit (jobs H6): a worst-case
 * publish event (7 per-platform captions of 2,200 characters) is about 70 KB, so
 * 50 of them (~3.5 MB) fit the 4 MiB step-output limit
 * (https://www.inngest.com/docs/usage-limits/inngest) and, with room to spare, a
 * batched send's total request size, whose limit is unconfirmed. One send of all
 * 1000 would not.
 */
export const MATERIALIZE_CHUNK_SIZE = 50;

/**
 * How long a job may sit in `in_progress` before the reconcilers assume the
 * publish run died without finalizing (materialize crash, deploy mid-run, etc.).
 */
export const STUCK_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;

/** Max stuck jobs reconciled per scan. */
export const STUCK_RECONCILE_BATCH = 50;

/**
 * Atomically claim scheduled jobs whose `scheduledFor` has arrived.
 *
 * ONE statement (2026-11-01 audit): the inner SELECT locks the due rows with
 * `FOR UPDATE SKIP LOCKED` and the UPDATE flips exactly those to
 * `in_progress`, returning their ids. It either commits as a whole or not at
 * all, so a failure can never leave rows claimed-but-unreported — the old
 * find-then-flip-each loop stranded every row it had already flipped when it
 * threw mid-loop (the step retry re-queries only `scheduled`). A concurrent
 * scanner skips rows this one holds; a `cancel`/`PATCH` that already moved a
 * row out of `scheduled` makes it ineligible. No job is ever double-claimed
 * and thus never double-posted.
 *
 * Never claims a submitted-but-unapproved job (`submittedForApprovalAt` set,
 * `approvedAt` null): the old approval bypass could leave such rows
 * `scheduled`, and the cron must not publish unreviewed posts (controller
 * ruling R6; migration `20261101120000_rehold_unapproved_scheduled` re-holds
 * the existing ones as drafts).
 *
 * Timestamps: Prisma binds a JS Date as `timestamptz`, while DateTime columns
 * are `timestamp(3)` holding UTC wall-clock time — so the bound `now` is
 * converted `AT TIME ZONE 'UTC'` instead of letting Postgres cast via the
 * session TimeZone.
 *
 * Returns the claimed ids, oldest `scheduledFor` first. ≤1-minute latency is
 * fine for a social scheduler.
 */
export async function claimDueScheduledJobs(
  now: Date,
  take: number = DUE_SCAN_BATCH,
): Promise<string[]> {
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    WITH claimed AS (
      UPDATE "PostJob"
      SET "status" = 'in_progress'::"PostJobStatus",
          "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "PostJob"
        WHERE "status" = 'scheduled'::"PostJobStatus"
          AND "scheduledFor" <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND NOT ("submittedForApprovalAt" IS NOT NULL AND "approvedAt" IS NULL)
        ORDER BY "scheduledFor" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "scheduledFor"
    )
    SELECT "id" FROM claimed ORDER BY "scheduledFor" ASC`;

  return claimed.map((row) => row.id);
}

/** What {@link materializeClaimedJobs} hands to the scanner's batched sends. */
export interface MaterializedBatch {
  /** `post/publish.requested` events (stable id, `immediate: false`), one per ok job. */
  publishEvents: PublishEvent[];
  /** Jobs marked `failed` for lack of an eligible connection, with their owner to notify. */
  noConnections: Array<{ postJobId: string; userId: string }>;
  /** Claimed jobs that no longer exist (deleted between the claim and the materialize). */
  notFound: string[];
  /** Jobs whose materialize threw. They stay `in_progress` for the stuck-job reconciler. */
  errorIds: string[];
}

/**
 * Materialize a chunk of claimed jobs (the body of one `materialize-batch-<i>`
 * step): create each job's per-platform results from the connections that exist
 * now and build its publish event, exactly as the per-job step did.
 *
 * Jobs are handled one by one, each in its own try/catch (review Minor #1): one job
 * that throws (a DB blip) must not strand the rest of the chunk, which are already
 * `in_progress` and are never re-claimed (the claim only re-queries `scheduled`). A
 * thrown job goes to `errorIds` and stays `in_progress` for the reconciler, as
 * before. Everything here is idempotent (`prepareDeferredPostJobDispatch` creates
 * results only when none exist), so a re-run, e.g. a scan that straddles a deploy,
 * duplicates no rows; the stable event id then dedupes the second publish
 * (Review Focus 3).
 *
 * The output is step output, so it holds ids and event data only: no tokens, no
 * email addresses.
 */
export async function materializeClaimedJobs(postJobIds: string[]): Promise<MaterializedBatch> {
  const batch: MaterializedBatch = {
    publishEvents: [],
    noConnections: [],
    notFound: [],
    errorIds: [],
  };

  for (const postJobId of postJobIds) {
    try {
      const prep = await prepareDeferredPostJobDispatch(postJobId);
      if (prep.ok) {
        // The scanner is not "Post now": `immediate: false` keeps the run at
        // priority 0 behind user-triggered publishes.
        batch.publishEvents.push(buildPublishEvent(prep.event, { immediate: false }));
      } else if (prep.reason === "NO_CONNECTIONS") {
        // The job is already marked failed; look up whom to tell.
        const owner = await prisma.postJob.findUnique({
          where: { id: postJobId },
          select: { userId: true },
        });
        if (owner) {
          batch.noConnections.push({ postJobId, userId: owner.userId });
        } else {
          batch.notFound.push(postJobId);
        }
      } else {
        batch.notFound.push(postJobId);
      }
    } catch (error) {
      logger.error("[Inngest] Scheduled materialize failed", { postJobId, error });
      batch.errorIds.push(postJobId);
    }
  }

  return batch;
}

/**
 * Finalize jobs stuck in `in_progress` past {@link STUCK_IN_PROGRESS_MS}.
 *
 * A materialize/dispatch crash can leave claimed scheduled jobs (or a mid-
 * publish run) with status still `in_progress` forever — the next due-scan
 * only re-queries `scheduled`. For each stale row:
 *  - If there are result rows: recompute terminal status from them (and mark
 *    any still-`pending` results failed so recompute can complete).
 *  - If there are no results: mark the job `failed`.
 *
 * A still-`pending` result a platform step CLAIMED (`claimRunId` set; the claim
 * only lives inside one step, <= 300 s) lost its run mid-call and may already be
 * live, so it is marked PUBLISH_UNCONFIRMED ("check the platform before you
 * retry"). Only an unclaimed one, which provably never reached the platform, is
 * PUBLISH_STALLED ("you can retry"). 2026-11-01 scale audit (jobs H6).
 *
 * Conditional `updateMany` keeps concurrent reconcilers safe.
 */
export async function reconcileStuckInProgressJobs(
  now: Date,
  take: number = STUCK_RECONCILE_BATCH,
  maxAgeMs: number = STUCK_IN_PROGRESS_MS,
): Promise<{ reconciled: number }> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const candidates = await prisma.postJob.findMany({
    where: { status: "in_progress", updatedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take,
  });

  let reconciled = 0;
  for (const job of candidates) {
    const results = await prisma.postJobResult.findMany({
      where: { postJobId: job.id },
      select: { id: true, status: true, claimRunId: true },
    });

    if (results.length === 0) {
      const { count } = await prisma.postJob.updateMany({
        where: { id: job.id, status: "in_progress" },
        data: { status: "failed" },
      });
      if (count === 1) reconciled += 1;
      continue;
    }

    const pending = results.filter((r) => r.status === "pending");
    const claimedIds = pending.filter((r) => r.claimRunId != null).map((r) => r.id);
    const unclaimedIds = pending.filter((r) => r.claimRunId == null).map((r) => r.id);
    // The claim state is re-asserted in each write, so a result claimed (or
    // re-queued) since the read above is left to its run.
    if (claimedIds.length > 0) {
      await prisma.postJobResult.updateMany({
        where: { id: { in: claimedIds }, status: "pending", claimRunId: { not: null } },
        data: {
          status: "failed",
          errorCode: PUBLISH_UNCONFIRMED_CODE,
          errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
        },
      });
    }
    if (unclaimedIds.length > 0) {
      await prisma.postJobResult.updateMany({
        where: { id: { in: unclaimedIds }, status: "pending", claimRunId: null },
        data: {
          status: "failed",
          errorCode: "PUBLISH_STALLED",
          errorMessage:
            "Publish did not complete (stalled). You can retry this platform.",
        },
      });
    }

    const finalResults = await prisma.postJobResult.findMany({
      where: { postJobId: job.id },
      select: { status: true },
    });
    const finalStatus = recomputePostJobStatus(finalResults);
    const { count } = await prisma.postJob.updateMany({
      where: { id: job.id, status: "in_progress" },
      data: { status: finalStatus },
    });
    if (count === 1) reconciled += 1;
  }

  return { reconciled };
}
