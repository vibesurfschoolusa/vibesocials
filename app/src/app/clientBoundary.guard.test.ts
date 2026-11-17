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
 *
 * Further down: components a server file renders that need the browser
 * (handlers, hooks), and function props a server file passes to a client
 * component.
 *
 * These are text scans, not a compiler. What they still cannot see:
 * - handlers or functions passed through a spread (`{...props}`), a variable
 *   (`render={renderRow}`), or as children (`{(row) => ...}`);
 * - hooks called through an alias (`const use = React.useState`) or React 19's
 *   bare `use(`;
 * - a function prop on an element written after another prop's inline JSX on
 *   the same element (the nearest `<Tag` before the prop is taken as its element);
 * - side-effect imports (`import "./x"`) and require();
 * - files outside src/app and src/components for the render scans.
 * Every file without "use client" is treated as a server file.
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

/** The source with its comments taken out, so names in comments are not counted. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** The event-handler props and hook calls in a source, which only work in the browser. */
export function browserOnlyCode(source: string): string[] {
  const code = withoutComments(source);
  const handlers = [...code.matchAll(/\s(on[A-Z]\w*)=\{/g)].map((match) => match[1]);
  const hooks = [...code.matchAll(/(?:(?<![.\w$])|(?<=\bReact\.))(use[A-Z]\w*)\s*\(/g)].map((match) => match[1]);
  return [...new Set([...handlers, ...hooks])];
}

/**
 * The project files a source loads at run time (type-only ones left out):
 * imports, export-from re-exports (so a barrel such as components/ui/index.ts
 * passes its importers on), and import("...") calls such as next/dynamic's.
 */
function runtimeImports(file: string, source: string): string[] {
  const patterns = [
    /import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
    /export\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g,
    /(?<![.\w$])import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const targets: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const target = resolveImport(file, match[1]);
      if (target) targets.push(target);
    }
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

/** Where a file's imported binding `local` comes from: the specifier and its exported name. */
function importedBinding(source: string, local: string): { specifier: string; name: string } | null {
  for (const match of source.matchAll(/import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1];
    const defaultName = /^([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (defaultName === local) return { specifier: match[2], name: "default" };
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1].split(",") ?? []) {
      if (/^type\s/.test(part.trim())) continue;
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (!name) continue;
      if ((alias ?? name).trim() === local) return { specifier: match[2], name: name.trim() };
    }
  }
  return null;
}

/** True when `name` exported by `file` comes from a "use client" module, following export-from. */
function exportIsClient(file: string, name: string, read: (file: string) => string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = read(file);
  if (isClientModule(source)) return true;
  for (const match of source.matchAll(/export\s+(?:\{([^}]*)\}|\*)\s*from\s+["']([^"']+)["']/g)) {
    const target = resolveImport(file, match[2]);
    if (!target) continue;
    if (match[1] === undefined) {
      if (exportIsClient(target, name, read, seen)) return true;
      continue;
    }
    for (const part of match[1].split(",")) {
      const [original, alias] = part.trim().split(/\s+as\s+/);
      if (original && (alias ?? original).trim() === name && exportIsClient(target, original.trim(), read, seen)) return true;
    }
  }
  // `import { X } from "..."` then a separate `export { X }` (or `export { X as Y }`).
  for (const match of source.matchAll(/export\s*\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const part of match[1].split(",")) {
      const [local, alias] = part.trim().split(/\s+as\s+/);
      if (!local || (alias ?? local).trim() !== name) continue;
      const binding = importedBinding(source, local.trim());
      const target = binding && resolveImport(file, binding.specifier);
      if (target && exportIsClient(target, binding.name, read, seen)) return true;
    }
  }
  return false;
}

/**
 * "file: <Tag prop={function}>" for each inline function (not an on* handler,
 * which browserOnlyCode reports) that a file without "use client" passes to a
 * component from a "use client" module. Next cannot send a function to the
 * browser, so the page crashes as it did in the hotfix.
 */
export function serverFunctionProps(files: string[], read: (file: string) => string): string[] {
  const inScope = (file: string) => ["app", "components"].some((dir) => file.startsWith(path.join(SRC, dir) + path.sep));
  const violations: string[] = [];
  for (const file of files) {
    const source = read(file);
    if (!inScope(file) || isClientModule(source)) continue;
    const code = withoutComments(source);
    const inlineFunction = /\s([a-zA-Z]\w*)=\{\s*(?:async\s+)?(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
    for (const match of code.matchAll(inlineFunction)) {
      const prop = match[1];
      if (/^on[A-Z]/.test(prop)) continue;
      const tag = [...code.slice(0, match.index).matchAll(/<([A-Za-z][\w.]*)/g)].pop()?.[1];
      if (!tag || !/^[A-Z]/.test(tag)) continue;
      const binding = importedBinding(code, tag.split(".")[0]);
      const target = binding && resolveImport(file, binding.specifier);
      if (target && exportIsClient(target, binding.name, read)) {
        violations.push(`${path.relative(SRC, file)}: <${tag} ${prop}={function}>`);
      }
    }
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

// Hotfix review lows (R33 SS1): the shapes the first scan could not see.
describe("the boundary scan also follows", () => {
  // Real paths, so the imports resolve; their sources are the fixtures below.
  const panel = path.join(SRC, "components", "ui", "card.tsx");
  const barrel = path.join(SRC, "components", "ui", "index.ts");
  const page = path.join(SRC, "app", "reports", "page.tsx");
  const by = path.join("app", "reports", "page.tsx");
  const where = path.join("components", "ui", "card.tsx");

  it("a hook called as React.useX(", () => {
    const source = 'import React from "react";\nexport function Panel() { const [a] = React.useState(0); return a; }\n';
    expect(browserOnlyCode(source)).toEqual(["useState"]);
  });

  it("a component reached through an export-from barrel", () => {
    const sources: Record<string, string> = {
      [page]: 'import { Panel } from "@/components/ui";\nexport default function Page() { return <Panel />; }\n',
      [barrel]: 'export { Panel } from "@/components/ui/card";\n',
      [panel]: 'export function Panel() { return <button onClick={() => {}} />; }\n',
    };
    expect(serverRenderedBrowserCode([page, barrel, panel], (file) => sources[file])).toEqual([
      `${where} (onClick) <- ${path.join("components", "ui", "index.ts")}`,
    ]);
  });

  it("a component loaded with next/dynamic", () => {
    const sources: Record<string, string> = {
      [page]:
        'import dynamic from "next/dynamic";\nconst Panel = dynamic(() => import("@/components/ui/card"));\n' +
        "export default function Page() { return <Panel />; }\n",
      [panel]: 'import { useState } from "react";\nexport default function Panel() { useState(0); return null; }\n',
    };
    expect(serverRenderedBrowserCode([page, panel], (file) => sources[file])).toEqual([`${where} (useState) <- ${by}`]);
  });

  it("a barrel that imports a component and exports it in a separate statement", () => {
    const sources: Record<string, string> = {
      [page]:
        'import { Shown } from "@/components/ui";\n' +
        "export default function Page() { return <Shown renderRow={(row) => row} />; }\n",
      [barrel]: 'import { Panel } from "@/components/ui/card";\nexport { Panel as Shown };\n',
      [panel]: '"use client";\nexport function Panel() { return null; }\n',
    };
    expect(serverFunctionProps([page, barrel, panel], (file) => sources[file])).toEqual([`${by}: <Shown renderRow={function}>`]);
    sources[barrel] = 'import { Panel } from "@/components/ui/card";\nexport { Panel };\n';
    sources[page] = sources[page].replace(/Shown/g, "Panel");
    expect(serverFunctionProps([page, barrel, panel], (file) => sources[file])).toEqual([`${by}: <Panel renderRow={function}>`]);
  });

  it("a function prop not named on* (a render prop) passed from a server file to a client component", () => {
    const sources: Record<string, string> = {
      [page]:
        'import { Panel } from "@/components/ui";\n' +
        "export default function Page() { return <Panel title=\"x\" renderRow={(row) => <p>{row}</p>} />; }\n",
      [barrel]: 'export { Panel } from "@/components/ui/card";\n',
      [panel]: '"use client";\nexport function Panel() { return null; }\n',
    };
    const files = [page, barrel, panel];
    expect(serverFunctionProps(files, (file) => sources[file])).toEqual([`${by}: <Panel renderRow={function}>`]);
  });

  it("allows a function prop to a server component, an on* handler (the scan above has it), and a client file", () => {
    const sources: Record<string, string> = {
      [page]:
        'import { Panel } from "@/components/ui/card";\n' +
        "export default function Page() { return <Panel renderRow={function (row) { return row; }} />; }\n",
      [panel]: "export function Panel() { return null; }\n",
    };
    expect(serverFunctionProps([page, panel], (file) => sources[file])).toEqual([]);
    sources[panel] = '"use client";\nexport function Panel() { return null; }\n';
    sources[page] = sources[page].replace("renderRow", "onRow");
    expect(serverFunctionProps([page, panel], (file) => sources[file])).toEqual([]);
    sources[page] = `"use client";\n${sources[page].replace("onRow", "renderRow")}`;
    expect(serverFunctionProps([page, panel], (file) => sources[file])).toEqual([]);
  });

  it("finds no function prop passed from a server file to a client component under src/app and src/components", () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(serverFunctionProps(files, (file) => readFileSync(file, "utf8"))).toEqual([]);
  });
});

// Hotfix review low: reply-form uses hooks and handlers, so it says so itself
// rather than relying on every importer being a client file.
describe("components that need the browser say \"use client\" themselves", () => {
  it("reviews/reply-form.tsx", () => {
    expect(isClientModule(readFileSync(path.join(SRC, "components", "reviews", "reply-form.tsx"), "utf8"))).toBe(true);
  });
});
