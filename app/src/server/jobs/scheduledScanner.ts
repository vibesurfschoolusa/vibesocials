import { prisma } from "@/lib/db";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";

/**
 * Roadmap Phase 5 — DB-backed cron due-scanner claim logic (§6.2).
 *
 * The category-defining scheduler is a DB source of truth + a cron that claims
 * due jobs, NOT a weeks-long `step.sleepUntil` (which is a function-versioning
 * landmine and makes cancel/edit a run-teardown race). Extracted from the
 * Inngest function so the atomic-claim logic is unit-testable with a mocked
 * prisma, mirroring the route-test convention.
 */

/** Max due jobs claimed per scan; the every-minute cadence drains any backlog. */
export const DUE_SCAN_BATCH = 100;

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
