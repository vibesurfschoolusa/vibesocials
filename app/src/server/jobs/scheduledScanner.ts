import { prisma } from "@/lib/db";
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
 * Two-step so the claim is atomic per row even across concurrent scanner
 * instances: find due candidates, then flip each via a CONDITIONAL
 * `updateMany({ where: { id, status: "scheduled" } })`. Only a row STILL
 * `scheduled` flips to `in_progress` (count === 1); a second scanner that
 * already claimed it — or a `cancel`/`PATCH` that moved it — sees count === 0
 * and it's dropped. No job is ever double-claimed and thus never double-posted.
 *
 * Returns the ids this call actually claimed (to dispatch). ≤1-minute latency
 * is fine for a social scheduler.
 */
export async function claimDueScheduledJobs(
  now: Date,
  take: number = DUE_SCAN_BATCH,
): Promise<string[]> {
  const due = await prisma.postJob.findMany({
    where: { status: "scheduled", scheduledFor: { lte: now } },
    select: { id: true },
    orderBy: { scheduledFor: "asc" },
    take,
  });

  const claimed: string[] = [];
  for (const job of due) {
    const { count } = await prisma.postJob.updateMany({
      where: { id: job.id, status: "scheduled" },
      data: { status: "in_progress" },
    });
    if (count === 1) {
      claimed.push(job.id);
    }
  }

  return claimed;
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
      select: { id: true, status: true },
    });

    if (results.length === 0) {
      const { count } = await prisma.postJob.updateMany({
        where: { id: job.id, status: "in_progress" },
        data: { status: "failed" },
      });
      if (count === 1) reconciled += 1;
      continue;
    }

    const pendingIds = results.filter((r) => r.status === "pending").map((r) => r.id);
    if (pendingIds.length > 0) {
      await prisma.postJobResult.updateMany({
        where: { id: { in: pendingIds }, status: "pending" },
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
