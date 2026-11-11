import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The client connect link migration (16). It runs on the live database while
 * the previous code still serves, so it may only add: a new table with its
 * indexes and foreign key, and nullable columns.
 */
const SQL = readFileSync(
  fileURLToPath(
    new URL("../../../prisma/migrations/20261111063000_client_connect_link/migration.sql", import.meta.url),
  ),
  "utf8",
);
const statements = SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261111063000_client_connect_link", () => {
  it("only creates the new table and its indexes, adds nullable columns, and constrains only the new table", () => {
    for (const statement of statements) {
      const allowed =
        statement.startsWith('CREATE TABLE "WorkspaceConnectLink" ') ||
        /^CREATE (UNIQUE )?INDEX "WorkspaceConnectLink_[A-Za-z_]+_(key|idx)" ON "WorkspaceConnectLink"/.test(statement) ||
        statement.startsWith('ALTER TABLE "WorkspaceConnectLink" ADD CONSTRAINT ') ||
        /^ALTER TABLE "(PendingConnection|OAuthHandshake)" ADD COLUMN /.test(statement);
      expect(allowed, statement).toBe(true);
    }
    const code = statements.join(";\n").replace(/ ON DELETE CASCADE ON UPDATE CASCADE/g, "");
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|UPDATE|ALTER COLUMN)\b/i);
  });

  it("creates the link table with its platforms and expiry", () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE "WorkspaceConnectLink"'));
    expect(create).toBeDefined();
    for (const column of [
      '"id" TEXT NOT NULL',
      '"workspaceId" TEXT NOT NULL',
      '"tokenHash" TEXT NOT NULL',
      '"tokenSealed" TEXT NOT NULL',
      '"createdById" TEXT NOT NULL',
      '"platforms" "Platform"[]',
      '"expiresAt" TIMESTAMP(3) NOT NULL',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"revokedAt" TIMESTAMP(3),',
      '"lastUsedAt" TIMESTAMP(3),',
    ]) {
      expect(create, column).toContain(column);
    }
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "WorkspaceConnectLink_tokenHash_key" ON "WorkspaceConnectLink"("tokenHash")',
    );
    expect(statements.join(";")).toContain('REFERENCES "Workspace"("id") ON DELETE CASCADE');
  });

  it("adds the three link columns as nullable text", () => {
    const added = statements.filter((s) => / ADD COLUMN /.test(s)).join(" ");
    expect(added).toContain('ALTER TABLE "PendingConnection" ADD COLUMN "connectLinkId" TEXT');
    expect(added).toContain('ALTER TABLE "OAuthHandshake" ADD COLUMN "connectLinkId" TEXT');
    expect(added).toContain('ADD COLUMN "connectLinkNonce" TEXT');
    expect(added).not.toMatch(/NOT NULL/);
  });

  it("ends in LF only", () => {
    expect(SQL).not.toContain("\r");
  });
});
