-- Post numbers for Instagram, Facebook, LinkedIn and Pinterest (2026-11-10).
-- Additive: two nullable columns. The code still serving during the release
-- neither reads nor writes them.

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN "clicks" INTEGER,
ADD COLUMN "saves" INTEGER;
