import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Fix round 1 (23): the draft legal wording must not ship in the public
 * JavaScript. No "use client" file, and nothing such a file imports, however
 * indirectly, may import billingTerms.ts; server pages read it and pass plain
 * strings down only with billing on.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(SRC, "lib", "billingTerms.ts");
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null; // a package
  for (const candidate of [base, ...EXTENSIONS.map((ext) => base + ext)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/(?:import|export)\s[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
  return specifiers.flatMap((specifier) => resolveImport(file, specifier) ?? []);
}

function isClientFile(file: string): boolean {
  return /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8"));
}

describe("billingTerms.ts and the client bundle", () => {
  it("is imported by no client file, directly or through anything a client file imports", () => {
    const clientFiles = sourceFiles(SRC).filter(isClientFile);
    expect(clientFiles.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const start of clientFiles) {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const file = queue.shift() as string;
        for (const imported of importsOf(file)) {
          if (imported === TARGET) offenders.push(`${start} -> ${file}`);
          else if (!seen.has(imported)) {
            seen.add(imported);
            queue.push(imported);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds an import of it where there is one (the pricing page, a server page)", () => {
    expect(importsOf(join(SRC, "app", "pricing", "page.tsx"))).toContain(TARGET);
  });
});
