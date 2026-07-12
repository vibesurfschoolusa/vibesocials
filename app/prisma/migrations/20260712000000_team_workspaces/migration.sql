-- Team Workspaces (design doc §2). Structural SQL generated OFFLINE via
-- `prisma migrate diff --from-schema-datamodel <pristine> --to-schema-datamodel
-- prisma/schema.prisma --script` (no DB), then HAND-REORDERED into 4
-- prod-safe phases so this runs cleanly against a NON-EMPTY database (the raw
-- diff assumes an empty DB and adds `workspaceId` as NOT NULL in one step,
-- which would fail immediately on existing rows). Applied by the owner with
-- `prisma migrate deploy` — NEVER `migrate dev`.
--
-- Phase 1: create the WorkspaceRole enum + Workspace/WorkspaceMember/
--          WorkspaceInvite tables (self-contained; touches no existing row).
-- Phase 2: add `workspaceId` to SocialConnection/MediaItem/PostJob/PostMetric
--          as NULLABLE.
-- Phase 3: backfill — one personal Workspace + owner WorkspaceMember per
--          existing User (id = 'ws_'/'wm_' || userId: deterministic and
--          collision-free since User.id is already unique, no cuid() needed
--          in SQL — cuid format isn't enforced by the schema), then stamp
--          `workspaceId` on every row of the 4 tables via the creator's
--          personal workspace.
-- Phase 4: now that no row has a NULL workspaceId — SET NOT NULL, swap
--          SocialConnection's unique from [userId, platform] to
--          [workspaceId, platform], add the new `workspaceId` indexes, and
--          add the 4 FKs.
--
-- NOTE on PostMetric_userId_idx: the schema (`@@index([userId])` replaced by
-- `@@index([workspaceId])` on PostMetric) no longer declares this index, and
-- a plain `prisma migrate diff` against the two schemas emits a
-- `DROP INDEX "PostMetric_userId_idx"` for it. That line is deliberately
-- OMITTED from this migration per design doc §2 ("the DB index is left in
-- place; dropping it is a later cleanup") — `prisma validate`/`generate`
-- don't track extra DB-only indexes, so leaving it in place is safe drift.

-- ---- Phase 1: enum + new tables ----

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'member');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyWebsite" TEXT,
    "defaultHashtags" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key" ON "WorkspaceInvite"("tokenHash");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---- Phase 2: nullable workspaceId on the 4 existing tables ----

-- AlterTable
ALTER TABLE "SocialConnection" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "PostJob" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN     "workspaceId" TEXT;

-- ---- Phase 3: backfill — one personal workspace per existing user, owner
-- membership, data adoption ----

INSERT INTO "Workspace" ("id", "name", "companyWebsite", "defaultHashtags", "createdAt", "updatedAt")
SELECT 'ws_' || u."id", COALESCE(NULLIF(u."name", ''), split_part(u."email", '@', 1)) || '''s workspace',
       u."companyWebsite", u."defaultHashtags", NOW(), NOW()
FROM "User" u;

INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role", "createdAt")
SELECT 'wm_' || u."id", 'ws_' || u."id", u."id", 'owner', NOW() FROM "User" u;

UPDATE "SocialConnection" SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "MediaItem"        SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "PostJob"          SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;
UPDATE "PostMetric"       SET "workspaceId" = 'ws_' || "userId" WHERE "workspaceId" IS NULL;

-- ---- Phase 4: NOT NULL + SocialConnection unique swap + indexes + FKs ----

-- AlterTable
ALTER TABLE "SocialConnection" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MediaItem" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PostJob" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PostMetric" ALTER COLUMN "workspaceId" SET NOT NULL;

-- DropIndex
DROP INDEX "SocialConnection_userId_platform_key";

-- CreateIndex
CREATE UNIQUE INDEX "SocialConnection_workspaceId_platform_key" ON "SocialConnection"("workspaceId", "platform");

-- CreateIndex
CREATE INDEX "MediaItem_workspaceId_idx" ON "MediaItem"("workspaceId");

-- CreateIndex
CREATE INDEX "PostJob_workspaceId_idx" ON "PostJob"("workspaceId");

-- CreateIndex
CREATE INDEX "PostMetric_workspaceId_idx" ON "PostMetric"("workspaceId");

-- AddForeignKey
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostJob" ADD CONSTRAINT "PostJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
