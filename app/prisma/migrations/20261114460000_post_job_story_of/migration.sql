-- F6 (2026-11-14): the Story job of a "Feed and Story" post names its feed job,
-- so the client review link and the reports treat the two as one post.
-- Additive: one nullable column (no foreign key) and one index, no row is changed.
SET lock_timeout = '5s';
ALTER TABLE "PostJob" ADD COLUMN "storyOfPostJobId" TEXT;
CREATE INDEX "PostJob_storyOfPostJobId_idx" ON "PostJob"("storyOfPostJobId");
