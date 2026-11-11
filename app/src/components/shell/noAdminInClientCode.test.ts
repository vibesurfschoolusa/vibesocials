import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The admin pages and routes must not be discoverable by a customer (2026-11-10,
 * fix round 1). Every signed-in page ships the client components to everyone,
 * so none of them may name an admin path or the word; the account menu renders
 * the operator's link from data GET /api/workspaces sends only to operators.
 * The admin pages' own client code lives under src/app/admin, which only an
 * operator's browser is ever sent.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry) ? [full] : [];
  });
}

const clientFiles = walk(SRC)
  .filter((file) => !relative(SRC, file).split(sep).join("/").startsWith("app/admin/"))
  .filter((file) => /^\s*["']use client["']/.test(readFileSync(file, "utf-8")));

describe("client code outside the admin pages", () => {
  it("is found", () => {
    expect(clientFiles.some((file) => file.endsWith("account-menu.tsx"))).toBe(true);
  });

  it.each(clientFiles.map((file) => [relative(SRC, file), file]))(
    "%s names no admin path, no admin route and not the word",
    (_name, file) => {
      const text = readFileSync(file, "utf-8");
      expect(text).not.toMatch(/\/admin/i);
      expect(text).not.toMatch(/admin\/session/i);
      expect(text).not.toMatch(/\bAdmin\b/);
    },
  );

  it("the operator session route is gone", () => {
    expect(existsSync(join(SRC, "app", "api", "admin", "session"))).toBe(false);
  });
});
