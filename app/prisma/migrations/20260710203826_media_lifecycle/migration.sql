-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lastUsedAt" TIMESTAMP(3);
