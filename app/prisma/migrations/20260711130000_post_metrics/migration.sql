-- Roadmap Phase 8 — analytics (post performance, §7.3). Additive, generated
-- OFFLINE via `prisma migrate diff --from-schema-datamodel <pristine>
-- --to-schema-datamodel prisma/schema.prisma --script` (no DB). Applied by the
-- owner with `prisma migrate deploy`.
--
-- Adds the `PostMetric` current-stats snapshot (one row per
-- (platform, externalPostId), upserted in place by the hourly YouTube metrics
-- sync cron). DECOUPLED from SocialConnection: the FK below is ON DELETE SET
-- NULL (not Cascade), and userId/platform/externalPostId are denormalized onto
-- the row, so a metric SURVIVES a later result/connection deletion — history is
-- not eroded when a platform is disconnected.

-- CreateTable
CREATE TABLE "PostMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "postJobResultId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostMetric_userId_idx" ON "PostMetric"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PostMetric_platform_externalPostId_key" ON "PostMetric"("platform", "externalPostId");

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_postJobResultId_fkey" FOREIGN KEY ("postJobResultId") REFERENCES "PostJobResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (review Minor #6): owner FK cascades so a deleted user's metrics
-- are removed (no orphaned rows). Orthogonal to the survives-a-disconnect design,
-- which is served by the SetNull on postJobResultId above.
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
