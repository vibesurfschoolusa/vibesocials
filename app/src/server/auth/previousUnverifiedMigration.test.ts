import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R7-new-customer H1: an email change records when the address it replaced
 * was never confirmed. The migration runs on the live database while the
 * previous code still serves, so it only adds a nullable column.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const SQL = read("../../../prisma/migrations/20261114640000_email_change_previous_unverified/migration.sql");
const statements = SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261114640000_email_change_previous_unverified", () => {
  it("sets a lock timeout, then only adds one nullable column", () => {
    expect(statements).toEqual([
      "SET lock_timeout = '5s'",
      'ALTER TABLE "EmailChangeRequest" ADD COLUMN "previousEmailUnverified" BOOLEAN',
    ]);
  });

  it("matches the schema", () => {
    const schema = read("../../../prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model EmailChangeRequest {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/\n\s+previousEmailUnverified Boolean\?\n/);
  });
});
