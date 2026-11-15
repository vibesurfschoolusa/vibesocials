import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R6-security M1: registration, Google sign-in and email changes look up
 * whether an open undo window holds an address (server/auth/undoWindow.ts),
 * by EmailChangeRequest.previousEmail. The migration runs on the live
 * database while the previous code still serves, so it only adds an index.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const SQL = read("../../../prisma/migrations/20261114610000_email_change_previous_email_index/migration.sql");
const statements = SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261114610000_email_change_previous_email_index", () => {
  it("sets a lock timeout, then only adds the previous-address index", () => {
    expect(statements).toEqual([
      "SET lock_timeout = '5s'",
      'CREATE INDEX "EmailChangeRequest_previousEmail_idx" ON "EmailChangeRequest"("previousEmail")',
    ]);
  });

  it("matches the schema", () => {
    const schema = read("../../../prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model EmailChangeRequest {"));
    expect(model.slice(0, model.indexOf("\n}"))).toContain("@@index([previousEmail])");
  });
});
