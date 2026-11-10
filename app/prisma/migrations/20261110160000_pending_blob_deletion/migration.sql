-- Stored files waiting to be deleted after a workspace or account deletion.
-- A new table only, so the previous code keeps working.
CREATE TABLE "PendingBlobDeletion" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingBlobDeletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PendingBlobDeletion_createdAt_idx" ON "PendingBlobDeletion"("createdAt");
