import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLIENT_METADATA_FIELDS,
  DELETED_FILE_BASENAME,
  DELETED_FILE_EXTENSION_PATTERN,
  deletedMediaData,
} from "./deletedMediaData";

/**
 * G4 backfill: rows marked deleted before deletedMediaData existed still hold
 * the client's name, note and file name. The migration clears exactly what the
 * helper clears, with the same replacement values. These tests read the SQL
 * and check its rules against the helper's.
 */
const SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../prisma/migrations/20261114500000_clear_deleted_client_media_data/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const code = SQL.replace(/--.*$/gm, "");
const statements = code
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("20261114500000_clear_deleted_client_media_data", () => {
  it("sets the lock timeout first, then runs one UPDATE of MediaItem and nothing else", () => {
    expect(statements[0]).toBe("SET lock_timeout = '5s'");
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^UPDATE "MediaItem" SET /);
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|ALTER|CREATE|INSERT)\b/i);
  });

  it("touches only deleted upload link rows", () => {
    const where = statements[1].split(" WHERE ")[1];
    expect(where).toContain('"deletedAt" IS NOT NULL');
    expect(where).toContain(`jsonb_typeof("metadata") = 'object'`);
    expect(where).toContain(`"metadata"->>'source' = 'upload_link'`);
  });

  it("drops the same metadata keys as the helper", () => {
    const removed = [...statements[1].matchAll(/ - '([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(removed).toEqual([...CLIENT_METADATA_FIELDS]);
  });

  it("names the file the way the helper does", () => {
    const patterns = [...statements[1].matchAll(/'(\\.[^']+\$)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(pattern).toBe(DELETED_FILE_EXTENSION_PATTERN);
    expect(statements[1]).toContain(`'${DELETED_FILE_BASENAME}.' || lower(`);
    expect(statements[1]).toContain(`ELSE '${DELETED_FILE_BASENAME}' END`);

    // The SQL's rule, run in JS on the pattern it uses, gives the helper's name.
    const sqlPattern = new RegExp(patterns[0]);
    const sqlName = (name: string) => {
      const match = sqlPattern.exec(name);
      return match ? `${DELETED_FILE_BASENAME}.${match[1].toLowerCase()}` : DELETED_FILE_BASENAME;
    };
    for (const name of ["Maria at the pier.JPG", "clip.mp4", "no extension", "a.b.HEIC", "x.toolongextension1", "y."]) {
      const helper = deletedMediaData({ originalFilename: name, metadata: { source: "upload_link" } }, new Date());
      expect(sqlName(name), name).toBe(helper.originalFilename);
    }
  });
});
