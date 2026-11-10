-- Several photos in one post. Additive: a new table only. The previous release
-- keeps running against it during the release: it never reads the table and
-- publishes `PostJob.mediaItemId`, which is always the post's first photo.

-- CreateTable
CREATE TABLE "PostJobMedia" (
    "id" TEXT NOT NULL,
    "postJobId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostJobMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostJobMedia_mediaItemId_idx" ON "PostJobMedia"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PostJobMedia_postJobId_position_key" ON "PostJobMedia"("postJobId", "position");

-- AddForeignKey
ALTER TABLE "PostJobMedia" ADD CONSTRAINT "PostJobMedia_postJobId_fkey" FOREIGN KEY ("postJobId") REFERENCES "PostJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostJobMedia" ADD CONSTRAINT "PostJobMedia_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
