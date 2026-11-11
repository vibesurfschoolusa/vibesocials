import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The stripe_billing migration (21b). It cannot run here (no database), so its
 * text is checked: additive only (nullable columns, a new table, indexes), and
 * a second run changes nothing.
 */
const SQL = readFileSync(
  fileURLToPath(new URL("../../../prisma/migrations/20261110370000_stripe_billing/migration.sql", import.meta.url)),
  "utf8",
);
const statements = SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261110370000_stripe_billing", () => {
  it("adds four nullable Workspace columns, each only if missing", () => {
    expect(statements).toContain(
      'ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT, ' +
        'ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT, ' +
        'ADD COLUMN IF NOT EXISTS "trialReminderSentAt" TIMESTAMP(3), ' +
        'ADD COLUMN IF NOT EXISTS "trialEndedEmailSentAt" TIMESTAMP(3)',
    );
  });

  it("makes both Stripe ids unique", () => {
    expect(statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId")',
    );
    expect(statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeSubscriptionId_key" ON "Workspace"("stripeSubscriptionId")',
    );
  });

  it("creates the StripeEvent table keyed by Stripe's event id", () => {
    expect(statements).toContain(
      'CREATE TABLE IF NOT EXISTS "StripeEvent" ( "id" TEXT NOT NULL, "type" TEXT NOT NULL, ' +
        '"receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        'CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id") )',
    );
  });

  it("only adds: no drop, no rename, no update, no NOT NULL on an existing table", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|TRUNCATE)\b/i);
      if (statement.startsWith('ALTER TABLE "Workspace"')) expect(statement).not.toMatch(/NOT NULL/);
    }
    expect(statements).toHaveLength(4);
  });
});
