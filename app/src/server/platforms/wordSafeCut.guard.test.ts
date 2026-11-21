import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R64 platform-clients L1: the whole-word cut was fixed platform by platform
 * three rounds running (Instagram in R62, TikTok and LinkedIn in R63, X and
 * YouTube in R64), each time because a plain cut split a #tag or @mention.
 * One rule, for every platform client (src/server/platforms/*Client.ts), the
 * composer's preview (src/lib/platformPreview.ts) and every module they reach
 * through imports: none of them may import a plain cut from lib/truncate.ts
 * (truncateGraphemes, truncateUnits, truncateKeepingLinks). They cut with the
 * AtWord functions, or with fitTitle, which ends at a whole word too. A
 * namespace import of lib/truncate.ts counts as a plain cut, since it can't
 * be told apart. truncate.ts itself is not read: it defines the cuts.
 */

const SRC = path.resolve(__dirname, "..", "..");
const TRUNCATE = path.join(SRC, "lib", "truncate.ts");
const PLAIN_CUTS = new Set(["truncateGraphemes", "truncateUnits", "truncateKeepingLinks"]);

/**
 * Files that may keep a plain cut, each with why. Empty since R64: every
 * caption, title and description a platform gets is cut at a whole word.
 */
const ALLOWED: Record<string, string> = {};

/** The plain cuts `source` imports from lib/truncate.ts. */
function plainCutsIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (resolveImport(statement.moduleSpecifier.text, fileName) !== TRUNCATE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) found.push(`* as ${bindings.name.text}`);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (PLAIN_CUTS.has(name)) found.push(name);
      }
    }
  }
  return found;
}

/** The source file an import names, or null for a package. */
function resolveImport(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (existsSync(candidate)) return path.normalize(candidate);
    }
  }
  return null;
}

/** Every file imported by `fileName`, read as source (type-only imports too: harmless). */
function importsOf(fileName: string): string[] {
  const file = ts.createSourceFile(fileName, readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : null;
    if (specifier) {
      const resolved = resolveImport(specifier, fileName);
      if (resolved) found.push(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const PLATFORMS = path.join(SRC, "server", "platforms");
const ROOTS = [
  ...readdirSync(PLATFORMS)
    .filter((name) => /Client\.ts$/.test(name))
    .map((name) => path.join(PLATFORMS, name)),
  path.join(SRC, "lib", "platformPreview.ts"),
];

/** The roots and every file they reach through imports, truncate.ts left out. */
function reachedFiles(): string[] {
  const seen = new Set<string>();
  const queue = ROOTS.map((root) => path.normalize(root));
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next) || next === TRUNCATE || /\.test\.tsx?$/.test(next)) continue;
    seen.add(next);
    queue.push(...importsOf(next));
  }
  return [...seen].sort();
}

const relative = (fileName: string) => path.relative(SRC, fileName).split(path.sep).join("/");

describe("every platform cut ends at a whole word (R64 platform-clients L1)", () => {
  it("reads every platform client and the preview", () => {
    const reached = reachedFiles().map(relative);
    expect(ROOTS.length).toBeGreaterThanOrEqual(8);
    for (const name of [
      "server/platforms/xClient.ts",
      "server/platforms/youtubeClient.ts",
      "server/platforms/googleBusinessProfileClient.ts",
      "server/platforms/pinterestClient.ts",
      "lib/platformPreview.ts",
      "lib/xWeightedLength.ts",
      "lib/youtubeDescription.ts",
      "lib/pinterestApi.ts",
    ]) {
      expect(reached).toContain(name);
    }
  });

  it("no client, the preview or a module they import uses a plain cut", () => {
    const offenders = reachedFiles()
      .map((fileName) => ({ file: relative(fileName), cuts: plainCutsIn(readFileSync(fileName, "utf8"), fileName) }))
      .filter(({ file, cuts }) => cuts.length > 0 && !(file in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it("every allowed exception still has a plain cut and a reason", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      const fileName = path.join(SRC, file);
      expect(reason.length).toBeGreaterThan(20);
      expect(plainCutsIn(readFileSync(fileName, "utf8"), fileName)).not.toEqual([]);
    }
  });

  it("fails on a planted plain cut, renamed or not", () => {
    const fileName = path.join(PLATFORMS, "plantedClient.ts");
    expect(plainCutsIn('import { truncateGraphemes } from "@/lib/truncate";', fileName)).toEqual([
      "truncateGraphemes",
    ]);
    expect(plainCutsIn('import { truncateUnits as cut } from "@/lib/truncate";', fileName)).toEqual([
      "truncateUnits",
    ]);
    expect(plainCutsIn('import { truncateKeepingLinks } from "../../lib/truncate";', fileName)).toEqual([
      "truncateKeepingLinks",
    ]);
    expect(plainCutsIn('import * as truncate from "@/lib/truncate";', fileName)).toEqual(["* as truncate"]);
    expect(
      plainCutsIn('import { truncateGraphemesAtWord, truncateUnitsAtWord, fitTitle } from "@/lib/truncate";', fileName),
    ).toEqual([]);
  });
});
