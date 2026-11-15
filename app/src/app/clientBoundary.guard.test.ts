import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #161 (reverted in 7a8851b): settings/page.tsx, a server component, called
 * connectionsSectionIntro(), a plain function exported from a "use client"
 * file. Next turns every export of such a file into a client reference, so
 * calling one on the server throws and the page crashed in production. Unit
 * tests render the function directly and cannot see it.
 *
 * This scan finds every file under src/app, src/components, src/lib and
 * src/server WITHOUT "use client" that imports a lowercase (non-component)
 * value from a "use client" module and calls it. Such a helper belongs in a
 * module without the directive, which the client file imports too.
 *
 * Files without the directive that are only ever rendered inside client code
 * would be safe, but the scan cannot tell them from server files, so they are
 * held to the same rule: keep plain functions out of "use client" modules.
 */

const SRC = path.join(__dirname, "..");
const ROOTS = ["app", "components", "lib", "server"].map((dir) => path.join(SRC, dir));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** True when the file's first statement is the "use client" directive. */
export function isClientModule(source: string): boolean {
  const withoutComments = source.replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, "");
  return /^\s*["']use client["']/.test(withoutComments);
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The value names (not `type` ones) a file imports from each specifier. */
export function namedValueImports(source: string): Array<{ specifier: string; local: string }> {
  const found: Array<{ specifier: string; local: string }> = [];
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) continue;
    for (const part of match[2].split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const local = item.split(/\s+as\s+/).pop()!.trim();
      found.push({ specifier: match[3], local });
    }
  }
  return found;
}

/** "file -> name (from module)" for each plain function called across the boundary. */
export function boundaryViolations(files: string[], read: (file: string) => string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = read(file);
    if (isClientModule(source)) continue;
    for (const { specifier, local } of namedValueImports(source)) {
      if (!/^[a-z]/.test(local)) continue;
      const target = resolveImport(file, specifier);
      if (!target || !isClientModule(read(target))) continue;
      if (new RegExp(`(^|[^.\\w$])${local}\\s*\\(`).test(source.replace(/import[^;]*;/g, ""))) {
        violations.push(`${path.relative(SRC, file)} -> ${local} (from ${specifier})`);
      }
    }
  }
  return violations;
}

/**
 * Files without the directive that run only in the browser, because every file
 * importing them is a "use client" module. Each one is checked below, so an
 * exemption stops holding the moment a server file imports it.
 */
const CLIENT_ONLY_HELPERS = ["app/posts/bulk/bulkExtras.ts"];

function importersOf(target: string, files: string[]): string[] {
  return files.filter((file) =>
    namedValueImports(readFileSync(file, "utf8")).some(({ specifier }) => resolveImport(file, specifier) === target),
  );
}

describe("server code never calls a plain function from a \"use client\" module", () => {
  it("finds none under src/app, src/components, src/lib and src/server", () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(100);
    const exempt = new Set(CLIENT_ONLY_HELPERS.map((file) => path.join(SRC, file)));
    const scanned = files.filter((file) => !exempt.has(file));
    expect(boundaryViolations(scanned, (file) => readFileSync(file, "utf8"))).toEqual([]);
  });

  it("each exempt file is imported only by \"use client\" modules", () => {
    const files = ROOTS.flatMap(sourceFiles);
    for (const file of CLIENT_ONLY_HELPERS) {
      const importers = importersOf(path.join(SRC, file), files);
      expect(importers.length, file).toBeGreaterThan(0);
      for (const importer of importers) {
        expect(isClientModule(readFileSync(importer, "utf8")), `${file} is imported by ${importer}`).toBe(true);
      }
    }
  });

  it("catches the shape that crashed Settings (#161)", () => {
    const client = path.join(SRC, "components", "connections-section.tsx");
    const server = path.join(SRC, "app", "settings", "page.tsx");
    const sources: Record<string, string> = {
      [client]: '"use client";\n\nexport function connectionsSectionIntro(readOnly: boolean) { return ""; }\n',
      [server]:
        'import { ConnectionsSection, connectionsSectionIntro } from "@/components/connections-section";\n' +
        "export default function Page() { return connectionsSectionIntro(false); }\n",
    };
    expect(boundaryViolations([server], (file) => sources[file] ?? readFileSync(file, "utf8"))).toEqual([
      `${path.join("app", "settings", "page.tsx")} -> connectionsSectionIntro (from @/components/connections-section)`,
    ]);
  });

  it("allows a component from a client module, and a type, and a client file calling it", () => {
    const client = path.join(SRC, "components", "connections-section.tsx");
    const server = path.join(SRC, "app", "settings", "page.tsx");
    const sources: Record<string, string> = {
      [client]: '"use client";\nexport function helper() {}\nexport type Shape = {};\n',
      [server]:
        'import { ConnectionsSection, type Shape } from "@/components/connections-section";\n' +
        "export default function Page() { return null; }\n",
    };
    expect(boundaryViolations([server], (file) => sources[file] ?? readFileSync(file, "utf8"))).toEqual([]);
  });
});
