import { prisma } from "@/lib/db";

/**
 * Hourly heal of PostJobResult.workspaceId (2026-11-01 scale audit, db M5).
 *
 * The column is denormalized from the owning job and backfilled by migration
 * 20261103100100_backfill_post_job_result_workspace_id. Migrations run in the
 * production build while the previous deployment is still serving, and that code
 * does not set the column, so results it creates before the promotion (or during
 * a rollback) carry NULL. Publish-health counts by workspaceId and would miss
 * them. The stale sweep runs this once an hour until the NULLs are gone.
 *
 * Remove it in a later phase, once no NULL rows have been seen for a release.
 */

/**
 * Rows healed per run. Bounds the statement (and the row locks it takes) however
 * many NULLs a rollback window left behind; the next hourly run takes the rest.
 */
export const RESULT_WORKSPACE_HEAL_BATCH = 1000;

/**
 * Copy the job's workspace onto up to {@link RESULT_WORKSPACE_HEAL_BATCH} results
 * that still have none. The NULL rows are found through the
 * [workspaceId, updatedAt] index.
 *
 * Raw SQL on purpose, and it must never set the result's last-modified column:
 * publish-health reads it as "when the result finished", and a Prisma updateMany
 * would bump @updatedAt and drag every healed old result back into the 30-day
 * window. Only the workspace column changes. Idempotent: healed rows no longer
 * match the inner SELECT.
 *
 * The job's workspace is read with a correlated subquery rather than a
 * `FROM "PostJob" j` join. The planner's statistics see almost no NULLs here (the
 * backfill just removed them), so with the join it drives from every NULL row and
 * rescans the LIMIT subquery for each one: 10.5 s for a 20,000-row backlog on the
 * 3.6M-row audit seed, against 66 ms for this form, which always drives from the
 * (at most) 1,000 batch ids.
 */
export async function healResultWorkspaceIds(): Promise<{ healed: number }> {
  const healed = await prisma.$executeRaw`
    UPDATE "PostJobResult" r
    SET "workspaceId" = (SELECT j."workspaceId" FROM "PostJob" j WHERE j."id" = r."postJobId")
    WHERE r."id" IN (
      SELECT "id" FROM "PostJobResult"
      WHERE "workspaceId" IS NULL
      LIMIT ${RESULT_WORKSPACE_HEAL_BATCH}
    )`;
  return { healed };
}
