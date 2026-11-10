-- Client upload link (2026-11-10). Additive: one new table, its indexes and its
-- foreign key. No existing row is touched, so the code still serving during the
-- release keeps working.

-- CreateTable
CREATE TABLE "WorkspaceUploadLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSealed" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "uploadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkspaceUploadLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceUploadLink_tokenHash_key" ON "WorkspaceUploadLink"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceUploadLink_workspaceId_revokedAt_idx" ON "WorkspaceUploadLink"("workspaceId", "revokedAt");

-- AddForeignKey
ALTER TABLE "WorkspaceUploadLink" ADD CONSTRAINT "WorkspaceUploadLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
