-- 2026-11-01 audit (Task 5): keep publish history when a connection is removed.
--
-- PostJobResult.socialConnectionId used to be NOT NULL with ON DELETE CASCADE,
-- so "Disconnect" / "Switch account" (a SocialConnection deleteMany) silently
-- deleted every past result for that platform — Activity and Publish health
-- lost their history. Loosening only: the column becomes nullable and the FK
-- now SETs NULL on delete instead of cascading. Existing rows are untouched
-- (history already deleted by the old cascade cannot be recovered).

-- DropForeignKey
ALTER TABLE "PostJobResult" DROP CONSTRAINT "PostJobResult_socialConnectionId_fkey";

-- AlterTable
ALTER TABLE "PostJobResult" ALTER COLUMN "socialConnectionId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PostJobResult" ADD CONSTRAINT "PostJobResult_socialConnectionId_fkey" FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
