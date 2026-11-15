import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R14-client-journey L1 (= new-customer L1, security L1, pages): the
 * "You're already in <workspace>" page linked to GET /go with next/link. In
 * production Next prefetches a visible <Link>, so merely showing the page ran
 * /go, which sets the active-workspace cookie: the workspace switched before
 * anyone pressed anything.
 *
 * Rule: next/link and router.push / replace / prefetch only ever target
 * pages. A route handler (any route.ts) is reached with a plain <a href>, a
 * form, fetch or window.location, never through the client router, which
 * prefetches and keeps the old page's shell. The GET handlers with side
 * effects found when this was written are in SIDE_EFFECT_GET_ROUTES; the rule
 * holds for every route handler, so a new one is covered without a list
 * change.
 *
 * The scan reads string and template literals, and calls of helpers known to
 * build route-handler addresses (ROUTE_HANDLER_HELPERS). An href held in a
 * variable is not followed.
 */

const SRC = path.join(__dirname, "..");
const APP = path.join(SRC, "app");

/** GET route handlers that set a cookie or write data. */
const SIDE_EFFECT_GET_ROUTES = [
  "/go", // sets the active-workspace cookie
  "/api/auth/x/start", // each platform's start: saves the OAuth state, then leaves the site
  "/api/auth/linkedin/start",
  "/api/auth/x/callback", // each platform's callback: saves the connection
  "/api/auth/google_business_profile/callback",
  "/api/reviews/locations", // refreshes and saves the Google token
];

/** Helpers whose result is a route-handler address. */
const ROUTE_HANDLER_HELPERS = ["workspaceLink("];

function files(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

/** Each route.ts under src/app as a pattern over its address. */
function routeHandlerPatterns(): Array<{ route: string; pattern: RegExp }> {
  return files(APP, (name) => /^route\.tsx?$/.test(name)).map((file) => {
    const segments = path
      .relative(APP, path.dirname(file))
      .split(path.sep)
      .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
    const route = `/${segments.join("/")}`;
    const body = segments
      .map((segment) =>
        /^\[\[?\.\.\./.test(segment) ? "(?:/.*)?" : /^\[.*\]$/.test(segment) ? "/[^/]+" : `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      )
      .join("");
    return { route, pattern: new RegExp(`^${body || "/"}/?$`) };
  });
}

/** The text from `open` to its matching close, both included. */
function balanced(source: string, start: number, open: string, close: string): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** The first argument of a call whose "(" is at `start`. */
function firstArgument(source: string, start: number): string {
  const call = balanced(source, start, "(", ")").slice(1, -1);
  let depth = 0;
  for (let i = 0; i < call.length; i += 1) {
    const c = call[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) return call.slice(0, i);
  }
  return call;
}

/** The addresses an href expression can name, read from its literals; `${…}` reads as one segment. */
export function literalPaths(expression: string): string[] {
  const out: string[] = [];
  for (const match of expression.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, "x");
    if (text.startsWith("/")) out.push(text.split(/[?#]/)[0]);
  }
  return out;
}

/** What a file sends through next/link or the client router: [kind, expression]. */
export function routerTargets(source: string): Array<{ kind: string; expression: string }> {
  const out: Array<{ kind: string; expression: string }> = [];
  const linkName = /import\s+(\w+)\s+from\s+["']next\/link["']/.exec(source)?.[1];
  if (linkName) {
    for (const match of source.matchAll(new RegExp(`<${linkName}\\b`, "g"))) {
      // The opening tag's attributes run to the next element (its first child).
      const next = source.indexOf("<", match.index + 1);
      const tag = source.slice(match.index, next === -1 ? undefined : next);
      const href = /\bhref=/.exec(tag);
      if (!href) continue;
      const at = href.index + href[0].length;
      const expression = tag[at] === "{" ? balanced(tag, at, "{", "}") : (/^"[^"]*"/.exec(tag.slice(at))?.[0] ?? "");
      out.push({ kind: "Link", expression });
    }
  }
  for (const match of source.matchAll(/\brouter\.(push|replace|prefetch)\(/g)) {
    out.push({ kind: `router.${match[1]}`, expression: firstArgument(source, match.index + match[0].length - 1) });
  }
  return out;
}

/** The route handler an expression reaches, or null. */
export function routeHandlerTarget(expression: string, patterns = routeHandlerPatterns()): string | null {
  if (ROUTE_HANDLER_HELPERS.some((helper) => expression.includes(helper))) return expression;
  for (const target of literalPaths(expression)) {
    const hit = patterns.find(({ pattern }) => pattern.test(target));
    if (hit) return hit.route;
  }
  return null;
}

describe("no client-router navigation to a route handler", () => {
  const patterns = routeHandlerPatterns();

  it("the GET routes with side effects are route handlers the rule covers", () => {
    for (const route of SIDE_EFFECT_GET_ROUTES) {
      expect(routeHandlerTarget(`"${route}?a=1"`, patterns), route).not.toBeNull();
    }
  });

  it("the scan finds such a link in each shape", () => {
    const shapes = [
      `import Link from "next/link";\n<Link href={workspaceLink(id, "/", null)} className="a">Go</Link>`,
      `import Link from "next/link";\n<Link href="/go?w=1&to=%2F">Go</Link>`,
      'import NextLink from "next/link";\n<NextLink\n  href={`/api/auth/${platform}/start?w=${id}`}\n>x</NextLink>',
      `router.push("/go?w=" + id);`,
      'router.prefetch(`/api/reviews/locations`);',
    ];
    for (const shape of shapes) {
      const targets = routerTargets(shape);
      expect(targets, shape).toHaveLength(1);
      expect(routeHandlerTarget(targets[0].expression, patterns), shape).not.toBeNull();
    }
    // Pages are fine, and a page whose address starts like a handler's is not one.
    for (const page of [`<Link href="/settings#connections">`, `router.push("/")`, 'router.push(`/posts/new?mediaItemId=${id}`)', `router.push("/gone")`]) {
      for (const target of routerTargets(`import Link from "next/link";\n${page}`)) {
        expect(routeHandlerTarget(target.expression, patterns), page).toBeNull();
      }
    }
  });

  it("no file under src sends next/link or the client router to one", () => {
    const offenders: string[] = [];
    for (const file of files(SRC, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))) {
      for (const { kind, expression } of routerTargets(readFileSync(file, "utf8"))) {
        const hit = routeHandlerTarget(expression, patterns);
        if (hit) offenders.push(`${path.relative(SRC, file)}: ${kind} ${expression.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * R14-client-journey L1: the account menu reads its workspaces once per page
 * load, so after Join and after deleting a workspace the page loads in full
 * (as the account menu's switch and the Workspaces page's Open do); a client
 * navigation kept the previous workspace's name in the top bar.
 */
describe("a full page load after the active workspace changes", () => {
  const read = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");
  const body = (source: string, name: string) => {
    const at = source.indexOf(`async function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    return balanced(source, source.indexOf("{", at), "{", "}");
  };

  it("after Join", () => {
    const join = body(read(path.join("app", "join", "[token]", "join-view.tsx")), "handleJoin");
    expect(join).toContain('window.location.assign("/")');
    expect(join).not.toMatch(/router\./);
  });

  it("after deleting a workspace", () => {
    const remove = body(read(path.join("components", "team-section.tsx")), "handleDelete");
    expect(remove).toContain('window.location.assign("/")');
    expect(remove).not.toMatch(/router\./);
  });
});
