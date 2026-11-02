-- 2026-11-01 scale audit (jobs, YouTube metrics): refresh by staleness.
--
-- The hourly metrics sync refreshed only the newest 100 results, one API call
-- per video, so older videos stopped being refreshed. It now takes the results
-- least recently CHECKED first, 50 ids per videos.list call, within a per-run
-- quota budget. "Checked" is a new column on the result, stamped on every
-- attempt (found, not found or error): PostMetric.fetchedAt cannot order the
-- queue, because a deleted or private video never gets a metric row and would
-- sort first forever.
--
--   WHERE "platform" = 'youtube' AND "status" = 'success'
--     AND "externalPostId" IS NOT NULL
--     AND ("metricsCheckedAt" IS NULL OR "metricsCheckedAt" < <now - 50 min>)
--   ORDER BY "metricsCheckedAt" ASC NULLS FIRST, "createdAt" DESC LIMIT 200
--
-- Additive only: one nullable column (no default, so no table rewrite) and one
-- new index. The previous deployment that is still serving traffic while this
-- migration runs never reads or writes either. Plain CREATE INDEX on purpose
-- (see 20261101160000_scale_indexes): Prisma runs this file as a single script,
-- where CREATE INDEX CONCURRENTLY cannot be used, and "PostJobResult" is small
-- today. db-review M9 covers concurrent builds on big tables later. The
-- lock_timeout below makes the script give up rather than queue behind a long
-- writer and stall every insert into "PostJobResult".

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PostJobResult" ADD COLUMN "metricsCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PostJobResult_platform_status_metricsCheckedAt_idx" ON "PostJobResult"("platform", "status", "metricsCheckedAt");
