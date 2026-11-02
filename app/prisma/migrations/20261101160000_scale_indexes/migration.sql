-- 2026-11-01 scale audit: FK and hot-path indexes.
--
-- A scale audit loaded 1M posts and 3.6M PostJobResult rows into a throwaway
-- database. Without an index on "PostJobResult"."postJobId" every Activity and
-- Queue load and every publish step was a full table scan (120-630 ms); with
-- these indexes the same queries take about 0 ms. The other indexes cover the
-- foreign-key columns that ON DELETE CASCADE / SET NULL seek by, and the
-- media-library, Queue, retention and invite lookups (see the comment on each
-- @@index in schema.prisma).
--
-- Plain CREATE INDEX on purpose: the production tables are small today, and
-- Prisma runs this file as a single script, where CREATE INDEX CONCURRENTLY
-- cannot be used. Future indexes on big tables should instead be built
-- out-of-band with CREATE INDEX CONCURRENTLY, with the migration then marked
-- applied via `prisma migrate resolve --applied`.
--
-- Additive only: no existing index is dropped in this phase.

-- CreateIndex
CREATE INDEX "MediaItem_workspaceId_deletedAt_createdAt_id_idx" ON "MediaItem"("workspaceId", "deletedAt", "createdAt", "id");

-- CreateIndex
-- A HASH index on purpose: the shared-blob guard and the retention sweep only
-- look this column up by equality (= / IN), and a btree entry is capped at about
-- 2.7 KB, so a long stored URL would make CREATE INDEX (and later inserts) fail.
-- A hash index has no such row-size limit.
CREATE INDEX "MediaItem_storageLocation_idx" ON "MediaItem" USING HASH ("storageLocation");

-- CreateIndex
CREATE INDEX "MediaItem_userId_idx" ON "MediaItem"("userId");

-- CreateIndex
CREATE INDEX "PostJob_mediaItemId_status_idx" ON "PostJob"("mediaItemId", "status");

-- CreateIndex
CREATE INDEX "PostJob_workspaceId_status_createdAt_idx" ON "PostJob"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PostJob_userId_idx" ON "PostJob"("userId");

-- CreateIndex
CREATE INDEX "PostJobResult_postJobId_platform_idx" ON "PostJobResult"("postJobId", "platform");

-- CreateIndex
CREATE INDEX "PostJobResult_socialConnectionId_idx" ON "PostJobResult"("socialConnectionId");

-- CreateIndex
CREATE INDEX "PostJobResult_platform_createdAt_idx" ON "PostJobResult"("platform", "createdAt");

-- CreateIndex
CREATE INDEX "PostMetric_postJobResultId_idx" ON "PostMetric"("postJobResultId");

-- CreateIndex
CREATE INDEX "PostMetric_userId_idx" ON "PostMetric"("userId");

-- CreateIndex
CREATE INDEX "SocialConnection_userId_idx" ON "SocialConnection"("userId");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_workspaceId_revokedAt_idx" ON "WorkspaceInvite"("workspaceId", "revokedAt");
