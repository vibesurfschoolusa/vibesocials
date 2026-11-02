-- 2026-11-01 scale audit (jobs, media retention): keyset index for the batched
-- retention sweep.
--
-- The sweep now runs hourly and pages its candidates in 200-row batches:
--   WHERE "deletedAt" IS NULL AND "createdAt" < <cutoff>
--     AND ("createdAt", "id") > (<cursor>)
--   ORDER BY "createdAt", "id" LIMIT 200
-- Every eligible row satisfies "createdAt" < <cutoff> (lastUsedAt is never older
-- than createdAt), so this index serves the filter, the order and the cursor
-- without a sort.
--
-- Additive only: one new index, no column change, nothing dropped. The previous
-- deployment that is still serving traffic while this migration runs never
-- notices it. Plain CREATE INDEX on purpose (see 20261101160000_scale_indexes):
-- Prisma runs this file as a single script, where CREATE INDEX CONCURRENTLY
-- cannot be used, and the lock_timeout below makes it give up rather than queue
-- behind a long writer and stall every insert into "MediaItem".

SET lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "MediaItem_deletedAt_createdAt_id_idx" ON "MediaItem"("deletedAt", "createdAt", "id");
