import { prisma } from "@/lib/db";

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
