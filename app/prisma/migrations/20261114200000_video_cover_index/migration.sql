-- Video cover, fix round 1 (2026-11-14). Additive: one index, for the hourly
-- cover sweep and the shared-cover lookup. No row is changed.
CREATE INDEX "PostJob_coverImageUrl_idx" ON "PostJob"("coverImageUrl");
