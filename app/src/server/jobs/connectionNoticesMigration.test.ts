import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXPIRY_WARNING_LEAD_MS, expiryNoticeWhere } from "./connectionHealthSweep";
import { CONNECTION_EXPIRED_CODE } from "./connectionNotices";

/**
 * R5-publishing M1, release backlog: the migration adds the two notice columns,
 * then marks what is already there at release as told, so the first sweep emails
 * nobody about old or test connections; only what is flagged, or comes due,
 * after the release sends. These tests read the SQL and check its rules against
 * the sweep's own (connectionHealthSweep.ts, connectionNotices.ts).
 */
const SQL = readFileSync(
  fileURLToPath(
    new URL("../../../prisma/migrations/20261114570000_connection_notices/migration.sql", import.meta.url),
  ),
  "utf8",
);
const code = SQL.replace(/--.*$/gm, "");
const statements = code
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);
const where = (statement: string) => statement.split(" WHERE ")[1];

/** The SQL form of expiryNoticeWhere: unflagged, no refresh token, an expiry, not a Page token. */
function unrenewableClauses(): string[] {
  const notIn = (expiryNoticeWhere(new Date()).platform as { notIn: string[] }).notIn;
  return [
    `"needsReconnect" = false`,
    `"refreshToken" IS NULL`,
    `"expiresAt" IS NOT NULL`,
    `"platform" NOT IN (${notIn.map((p) => `'${p}'`).join(", ")})`,
  ];
}

describe("20261114570000_connection_notices", () => {
  it("sets the lock timeout first, adds the two nullable columns, then two UPDATEs and nothing else", () => {
    expect(statements[0]).toBe("SET lock_timeout = '5s'");
    expect(statements.slice(1, 3)).toEqual([
      'ALTER TABLE "SocialConnection" ADD COLUMN "reconnectEmailedAt" TIMESTAMP(3)',
      'ALTER TABLE "SocialConnection" ADD COLUMN "expiryWarnedFor" TIMESTAMP(3)',
    ]);
    expect(statements).toHaveLength(5);
    for (const statement of statements.slice(3)) expect(statement).toMatch(/^UPDATE "SocialConnection" SET /);
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|CREATE|INSERT)\b/i);
    expect(code).not.toMatch(/NOT NULL DEFAULT|SET NOT NULL/i);
  });

  it("marks every connection flagged at release as told about THIS flag", () => {
    // Its own flag time: the email counts as sent while reconnectEmailedAt >= refreshFailedAt,
    // so a flag written after the release (a later refreshFailedAt) still sends.
    expect(statements[3]).toBe(
      'UPDATE "SocialConnection" SET "reconnectEmailedAt" = COALESCE("refreshFailedAt", NOW()) WHERE "needsReconnect" = true',
    );
  });

  it("flags a sign-in that already ended at release as dead AND told, so the sweep sends no lapse email", () => {
    expect(statements[4]).toContain(`"needsReconnect" = true`);
    expect(statements[4]).toContain(`"lastRefreshErrorCode" = '${CONNECTION_EXPIRED_CODE}'`);
    expect(statements[4]).toContain(`"refreshFailedAt" = NOW()`);
    expect(statements[4]).toContain(`"reconnectEmailedAt" = NOW()`);
    for (const clause of unrenewableClauses()) expect(where(statements[4])).toContain(clause);
    expect(where(statements[4])).toContain(`"expiresAt" <= NOW()`);
  });

  // Review: a sign-in still running at release gets the real warning.
  it("marks no warning as sent: a sign-in ending within the week at release is warned by the sweep", () => {
    expect(code).not.toContain('"expiryWarnedFor" =');
    expect(EXPIRY_WARNING_LEAD_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
