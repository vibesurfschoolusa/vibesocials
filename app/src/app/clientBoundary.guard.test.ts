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

/**
 * Hotfix (digest 2711503741): button.tsx gained its own onClick in R25 but had
 * no "use client", so every server page that rendered <Button> (Reports, the
 * connect link) crashed with "Event handlers cannot be passed to Client
 * Component props". Unit tests render components directly and cannot see it.
 *
 * This scan finds every component module under src/app or src/components
 * WITHOUT "use client" that writes an inline event handler (`onClick={`) or
 * calls a hook (`useState(`), and is a page or layout, or is imported by a
 * file under src/app or src/components that has no "use client" either. As above, the scan holds
 * every file without the directive to the server's rules: a component that
 * needs the browser says "use client".
 */

/** The event-handler props and hook calls in a source, which only work in the browser. */
export function browserOnlyCode(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const handlers = [...code.matchAll(/\s(on[A-Z]\w*)=\{/g)].map((match) => match[1]);
  const hooks = [...code.matchAll(/(?<![.\w$])(use[A-Z]\w*)\s*\(/g)].map((match) => match[1]);
  return [...new Set([...handlers, ...hooks])];
}

/** The project files a source imports at run time (type-only imports left out). */
function runtimeImports(file: string, source: string): string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g)) {
    const target = resolveImport(file, match[1]);
    if (target) targets.push(target);
  }
  return targets;
}

/** "component (handlers, hooks) <- server importers" for each component that needs "use client". */
export function serverRenderedBrowserCode(files: string[], read: (file: string) => string): string[] {
  const inScope = (file: string) => ["app", "components"].some((dir) => file.startsWith(path.join(SRC, dir) + path.sep));
  const importers = new Map<string, string[]>();
  for (const file of files) {
    const source = read(file);
    if (!inScope(file) || isClientModule(source)) continue;
    // A page or layout is itself rendered on the server, imported or not.
    if (/^(page|layout|template|not-found|loading|default)\.tsx$/.test(path.basename(file))) {
      importers.set(file, [...(importers.get(file) ?? []), "Next.js"]);
    }
    for (const target of runtimeImports(file, source)) {
      if (!inScope(target)) continue;
      importers.set(target, [...(importers.get(target) ?? []), path.relative(SRC, file)]);
    }
  }
  const violations: string[] = [];
  for (const [target, by] of importers) {
    const source = read(target);
    if (isClientModule(source)) continue;
    const found = browserOnlyCode(source);
    if (found.length > 0) violations.push(`${path.relative(SRC, target)} (${found.join(", ")}) <- ${by.join(", ")}`);
  }
  return violations.sort();
}

describe("a component a server file renders has \"use client\" when it needs the browser", () => {
  const button = path.join(SRC, "components", "ui", "button.tsx");
  const page = path.join(SRC, "app", "reports", "page.tsx");
  const withHandler = 'export function Button() { return <button onClick={() => {}} />; }\n';
  const withHook = 'import { useState } from "react";\nexport function Button() { const [a] = useState(0); return a; }\n';
  const pageSource = (directive: string) =>
    `${directive}import { Button } from "@/components/ui/button";\nexport default function Page() { return <Button />; }\n`;
  const scan = (sources: Record<string, string>) =>
    serverRenderedBrowserCode([page, button], (file) => sources[file] ?? readFileSync(file, "utf8"));
  const where = path.join("components", "ui", "button.tsx");
  const by = path.join("app", "reports", "page.tsx");

  it("finds none under src/app and src/components", () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(serverRenderedBrowserCode(files, (file) => readFileSync(file, "utf8"))).toEqual([]);
  });

  it("catches the shape that crashed Reports: an onClick in a component without the directive", () => {
    expect(scan({ [button]: withHandler, [page]: pageSource("") })).toEqual([`${where} (onClick) <- ${by}`]);
  });

  it("catches a hook in a component without the directive", () => {
    expect(scan({ [button]: withHook, [page]: pageSource("") })).toEqual([`${where} (useState) <- ${by}`]);
  });

  it("allows the same component once it says \"use client\", or when only client files import it", () => {
    expect(scan({ [button]: `"use client";\n${withHandler}`, [page]: pageSource("") })).toEqual([]);
    expect(scan({ [button]: withHook, [page]: pageSource('"use client";\n') })).toEqual([]);
  });

  it("catches a handler in a page itself", () => {
    const pageWithHandler = 'export default function Page() { return <form onSubmit={() => {}} />; }\n';
    expect(serverRenderedBrowserCode([page], () => pageWithHandler)).toEqual([`${by} (onSubmit) <- Next.js`]);
  });

  it("ignores handlers and hooks named only in comments", () => {
    const commented = "// onClick={go} and useState( in a comment\n/* onChange={x} */\nexport const A = 1;\n";
    expect(scan({ [button]: commented, [page]: pageSource("") })).toEqual([]);
  });
});
