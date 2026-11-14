-- F1 H3 (2026-11-14): when the scheduled-post scanner first picked a post up,
-- so the 2 h give-up counts from the pickup; when the reconciler gave up on a
-- post and when its owner was told, so that notification cannot be lost.
-- Additive: three nullable columns and one index, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "PostJob" ADD COLUMN "pickedUpAt" TIMESTAMP(3);
ALTER TABLE "PostJob" ADD COLUMN "gaveUpAt" TIMESTAMP(3);
ALTER TABLE "PostJob" ADD COLUMN "gaveUpNotifiedAt" TIMESTAMP(3);
CREATE INDEX "PostJob_gaveUpAt_idx" ON "PostJob"("gaveUpAt");
