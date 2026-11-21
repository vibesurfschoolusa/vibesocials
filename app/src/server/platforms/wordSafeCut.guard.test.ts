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
 * through imports: none of them may import or re-export a plain cut from lib/truncate.ts
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

/**
 * The plain cuts `source` takes from lib/truncate.ts: imported, re-exported
 * (R64 fix review L1: by name, `export *` or `export * as`), or reached with
 * `import()`, which counts as a namespace import since its use can't be told
 * apart.
 */
function plainCutsIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const isTruncate = (specifier: ts.Node | undefined) =>
    specifier !== undefined && ts.isStringLiteral(specifier) && resolveImport(specifier.text, fileName) === TRUNCATE;
  const named = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) => {
    for (const element of elements) {
      const name = (element.propertyName ?? element.name).text;
      if (PLAIN_CUTS.has(name)) found.push(name);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isTruncate(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) found.push(`* as ${bindings.name.text}`);
      if (bindings && ts.isNamedImports(bindings)) named(bindings.elements);
    } else if (ts.isExportDeclaration(node) && isTruncate(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause) found.push("export *");
      else if (ts.isNamespaceExport(clause)) found.push(`export * as ${clause.name.text}`);
      else named(clause.elements);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isTruncate(node.arguments[0])
    ) {
      found.push(`import(${node.arguments[0].getText(file)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** How the walk reads files: the disk, or the disk with planted files on top (the planted tests). */
interface Files {
  read: (fileName: string) => string;
  exists: (fileName: string) => boolean;
}
const DISK: Files = { read: (fileName) => readFileSync(fileName, "utf8"), exists: existsSync };

/** The disk with `planted` (path relative to src, source) on top. */
function withPlanted(planted: Record<string, string>): Files {
  const byPath = new Map(Object.entries(planted).map(([file, source]) => [path.normalize(path.join(SRC, file)), source]));
  return {
    read: (fileName) => byPath.get(path.normalize(fileName)) ?? DISK.read(fileName),
    exists: (fileName) => byPath.has(path.normalize(fileName)) || DISK.exists(fileName),
  };
}

/** The source file an import names, or null for a package. */
function resolveImport(specifier: string, fromFile: string, files: Files = DISK): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (files.exists(candidate)) return path.normalize(candidate);
    }
  }
  return null;
}

/** Every file imported by `fileName`, read as source (type-only imports too: harmless). */
function importsOf(fileName: string, files: Files): string[] {
  const file = ts.createSourceFile(fileName, files.read(fileName), ts.ScriptTarget.Latest, true);
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
      const resolved = resolveImport(specifier, fileName, files);
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
function reachedFiles(roots: string[] = ROOTS, files: Files = DISK): string[] {
  const seen = new Set<string>();
  const queue = roots.map((root) => path.normalize(root));
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next) || next === TRUNCATE || /\.test\.tsx?$/.test(next)) continue;
    seen.add(next);
    queue.push(...importsOf(next, files));
  }
  return [...seen].sort();
}

const relative = (fileName: string) => path.relative(SRC, fileName).split(path.sep).join("/");

/** The reached files that use a plain cut and aren't allowed, with the cuts. */
function offenders(roots: string[] = ROOTS, files: Files = DISK) {
  return reachedFiles(roots, files)
    .map((fileName) => ({ file: relative(fileName), cuts: plainCutsIn(files.read(fileName), fileName) }))
    .filter(({ file, cuts }) => cuts.length > 0 && !(file in ALLOWED));
}

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
    expect(offenders()).toEqual([]);
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

  // R64 fix review L1: a re-export or a dynamic import can't hide a plain cut.
  const plantedClient = path.join(PLATFORMS, "plantedClient.ts");

  it("fails on a planted lib file that re-exports truncateGraphemes, imported by a client", () => {
    const files = withPlanted({
      "server/platforms/plantedClient.ts": [
        'import { truncateGraphemes } from "@/lib/plantedCuts";',
        "export const cut = (text: string) => truncateGraphemes(text, 280);",
      ].join("\n"),
      "lib/plantedCuts.ts": 'export { truncateGraphemes } from "./truncate";',
    });
    expect(offenders([plantedClient], files)).toEqual([{ file: "lib/plantedCuts.ts", cuts: ["truncateGraphemes"] }]);
  });

  it("fails on a planted export * of lib/truncate.ts", () => {
    const files = withPlanted({
      "server/platforms/plantedClient.ts": ['import { truncateUnits } from "@/lib/plantedCuts";', "export { truncateUnits };"].join(
        "\n",
      ),
      "lib/plantedCuts.ts": 'export * from "@/lib/truncate";',
    });
    expect(offenders([plantedClient], files)).toEqual([{ file: "lib/plantedCuts.ts", cuts: ["export *"] }]);
  });

  it("fails on a planted await import of lib/truncate.ts inside a client", () => {
    const files = withPlanted({
      "server/platforms/plantedClient.ts": [
        "export async function cut(text: string) {",
        '  const truncate = await import("@/lib/truncate");',
        "  return truncate.truncateGraphemes(text, 280);",
        "}",
      ].join("\n"),
    });
    expect(offenders([plantedClient], files)).toEqual([
      { file: "server/platforms/plantedClient.ts", cuts: ['import("@/lib/truncate")'] },
    ]);
  });
});
