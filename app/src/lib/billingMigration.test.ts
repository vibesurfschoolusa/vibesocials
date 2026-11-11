import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The workspace_plan migration (21a). It cannot run here (no database), so its
 * text is checked: additive, every workspace that exists when it runs is
 * exempt, later ones are not, and a second run changes nothing.
 */
const SQL = readFileSync(
  fileURLToPath(new URL("../../prisma/migrations/20261110350000_workspace_plan/migration.sql", import.meta.url)),
  "utf8",
);
const statements = SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261110350000_workspace_plan", () => {
  it("adds the five nullable or defaulted columns, each only if missing", () => {
    expect(statements).toContain(
      'ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "plan" TEXT, ' +
        'ADD COLUMN IF NOT EXISTS "planStatus" TEXT, ' +
        'ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3), ' +
        'ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3)',
    );
  });

  it("marks every existing workspace exempt by adding the column with true, then defaults new ones to false", () => {
    const add = statements.indexOf(
      'ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "billingExempt" BOOLEAN NOT NULL DEFAULT true',
    );
    const flip = statements.indexOf('ALTER TABLE "Workspace" ALTER COLUMN "billingExempt" SET DEFAULT false');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(flip).toBeGreaterThan(add);
  });

  it("is safe to run twice: no statement fails or touches a row on a second run", () => {
    expect(statements).toHaveLength(3);
    // No UPDATE: a second run would otherwise exempt workspaces created since.
    const code = statements.join(";\n");
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    for (const statement of statements.filter((s) => s.includes("ADD COLUMN"))) {
      expect(statement.match(/ADD COLUMN/g)?.length).toBe(statement.match(/ADD COLUMN IF NOT EXISTS/g)?.length);
    }
  });

  it("ends in LF only", () => {
    expect(SQL).not.toContain("\r");
  });
});
