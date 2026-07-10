-- AlterTable
ALTER TABLE "SocialConnection" ADD COLUMN     "lastRefreshErrorCode" TEXT,
ADD COLUMN     "needsReconnect" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refreshFailedAt" TIMESTAMP(3);
