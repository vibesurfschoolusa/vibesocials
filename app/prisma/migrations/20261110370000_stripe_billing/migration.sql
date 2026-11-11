-- Stripe payments (21b, 2026-11-10). Additive: four nullable columns on
-- Workspace, two unique indexes on them and one new table. The code still
-- serving during the release never reads any of them. Every statement is
-- IF NOT EXISTS, so a second run changes nothing.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT,
ADD COLUMN IF NOT EXISTS "trialReminderSentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "trialEndedEmailSentAt" TIMESTAMP(3);

-- CreateIndex: every value is NULL when this runs, so it cannot fail on duplicates
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId");

-- CreateTable: each Stripe event handled once
CREATE TABLE IF NOT EXISTS "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);
