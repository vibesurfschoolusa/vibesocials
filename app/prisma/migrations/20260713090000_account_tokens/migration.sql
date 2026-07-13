-- Account lifecycle (scale-readiness spec §A). AUTHORED OFFLINE, never applied
-- here: the OWNER applies it with `prisma migrate deploy` — NEVER `migrate dev`.
--
-- The DDL below is byte-identical to the output of a schema-to-schema diff
-- (no database touched):
--   prisma migrate diff \
--     --from-schema-datamodel <pre-change schema.prisma> \
--     --to-schema-datamodel   prisma/schema.prisma --script
--
-- DELIBERATE DELTA vs that diff output: the final `UPDATE "User" ...` backfill
-- is HAND-ADDED and does NOT appear in the schema-to-schema diff (a diff only
-- knows structure, not data intent). Existing users predate email
-- verification, so they are grandfathered as verified (emailVerifiedAt stamped
-- CURRENT_TIMESTAMP) — this rollout must lock nobody out. New users register
-- with emailVerifiedAt = NULL and verify via the email flow. Safe to run after
-- the ADD COLUMN above (the column exists by then) and idempotent (guarded by
-- `WHERE "emailVerifiedAt" IS NULL`).

-- CreateEnum
CREATE TYPE "AccountTokenType" AS ENUM ('password_reset', 'email_verify');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AccountTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountToken_userId_type_idx" ON "AccountToken"("userId", "type");

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (hand-added; see header): grandfather existing users as verified.
UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerifiedAt" IS NULL;
