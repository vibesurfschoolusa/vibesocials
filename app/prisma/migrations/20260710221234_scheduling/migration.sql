-- Roadmap Phase 5 — scheduling + drafts. Additive, generated OFFLINE via
-- `prisma migrate diff --from-schema-datamodel <pristine> --to-schema-datamodel
-- prisma/schema.prisma --script` (no DB). Applied by the owner with
-- `prisma migrate deploy`.
--
-- ENUM-IN-TRANSACTION NOTE: Postgres 12+ permits `ALTER TYPE ... ADD VALUE`
-- inside a transaction block (Prisma wraps each migration in one) *as long as
-- the new values are not USED in the same transaction*. They are not here — the
-- ADD COLUMN and CREATE INDEX below reference the `status` column, never a new
-- enum literal — so this is safe on Neon (PG 15). On PG <= 11 (not this DB) the
-- three ADD VALUEs would need to be split into separate migrations.

-- AlterEnum
ALTER TYPE "PostJobStatus" ADD VALUE 'draft';
ALTER TYPE "PostJobStatus" ADD VALUE 'scheduled';
ALTER TYPE "PostJobStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "PostJob" ADD COLUMN     "baseCaption" TEXT,
ADD COLUMN     "perPlatformOverrides" JSONB,
ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PostJob_status_scheduledFor_idx" ON "PostJob"("status", "scheduledFor");
