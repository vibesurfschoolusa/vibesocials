-- Repeat posts and posting times (2026-11-10). Additive: two nullable columns
-- and one index. No existing row is touched, so the code still serving during
-- the release keeps working.

-- AlterTable
ALTER TABLE "PostJob" ADD COLUMN "seriesId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "postingSlots" JSONB;

-- CreateIndex
CREATE INDEX "PostJob_seriesId_idx" ON "PostJob"("seriesId");
