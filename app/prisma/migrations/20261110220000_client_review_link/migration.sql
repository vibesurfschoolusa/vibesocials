-- Client review link (2026-11-10). Additive: one new table with its indexes and
-- foreign key, and three nullable columns on PostJob. No existing row is
-- touched, so the code still serving during the release keeps working.

-- CreateTable
CREATE TABLE "WorkspaceReviewLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSealed" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceReviewLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceReviewLink_tokenHash_key" ON "WorkspaceReviewLink"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceReviewLink_workspaceId_revokedAt_idx" ON "WorkspaceReviewLink"("workspaceId", "revokedAt");

-- AddForeignKey
ALTER TABLE "WorkspaceReviewLink" ADD CONSTRAINT "WorkspaceReviewLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PostJob" ADD COLUMN "clientApprovedAt" TIMESTAMP(3),
ADD COLUMN "clientChangeRequestedAt" TIMESTAMP(3),
ADD COLUMN "clientNote" TEXT;
