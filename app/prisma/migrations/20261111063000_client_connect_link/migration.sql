-- Client connect link (2026-11-11). Additive: one new table with its indexes
-- and foreign key, and three nullable columns. No existing row is touched, so
-- the code still serving during the release keeps working.

-- CreateTable
CREATE TABLE "WorkspaceConnectLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSealed" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "platforms" "Platform"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceConnectLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConnectLink_tokenHash_key" ON "WorkspaceConnectLink"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceConnectLink_workspaceId_revokedAt_idx" ON "WorkspaceConnectLink"("workspaceId", "revokedAt");

-- AddForeignKey
ALTER TABLE "WorkspaceConnectLink" ADD CONSTRAINT "WorkspaceConnectLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PendingConnection" ADD COLUMN "connectLinkId" TEXT;

-- AlterTable
ALTER TABLE "OAuthHandshake" ADD COLUMN "connectLinkId" TEXT,
ADD COLUMN "connectLinkNonce" TEXT;
