-- 2026-11-01 scale audit (db M5, web W16): a workspace-scoped results index.
--
-- /api/insights/publish-health found a workspace's recent results by joining
-- "PostJobResult" to "PostJob". The scale test measured about 400 ms for every
-- workspace without a "postJobId" index, and 0.4-0.9 s for a 50k-post workspace
-- even with one. The workspace is now stored on the result itself, and the read
-- counts from the index below.
--
-- Additive only: one nullable column (no default, so no table rewrite) and one
-- new index. The previous deployment that is still serving traffic while this
-- migration runs never reads the column, and its inserts leave it NULL, which
-- the nullable column allows. There is NO foreign key on purpose: results already
-- die with their job ("PostJob" cascade), and an FK would validate the whole
-- table under SHARE ROW EXCLUSIVE locks on both tables while it is built.
--
-- Existing rows are filled by the next migration
-- (20261103100100_backfill_post_job_result_workspace_id). Rows the previous
-- deployment writes between the two migrations and the promotion carry NULL; the
-- hourly stale sweep heals them (resultWorkspaceHeal.ts).
--
-- Plain CREATE INDEX on purpose (see 20261101160000_scale_indexes): Prisma runs
-- this file as a single script, where CREATE INDEX CONCURRENTLY cannot be used,
-- and "PostJobResult" is small today. The lock_timeout below makes the script
-- give up rather than queue behind a long writer and stall every insert into
-- "PostJobResult".

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PostJobResult" ADD COLUMN "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "PostJobResult_workspaceId_updatedAt_idx" ON "PostJobResult"("workspaceId", "updatedAt");
