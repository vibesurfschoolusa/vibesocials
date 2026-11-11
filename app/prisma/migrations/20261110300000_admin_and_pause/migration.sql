-- Operator admin page and workspace pause (2026-11-10). Additive: two nullable
-- columns on Workspace and one new table. No existing row is touched, so the
-- code still serving during the release keeps working.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "pausedReason" TEXT;

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "operatorEmail" TEXT NOT NULL,
    "workspaceId" TEXT,
    "workspaceName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAction_workspaceId_createdAt_idx" ON "AdminAction"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
