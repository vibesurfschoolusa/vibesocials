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

/**
 * Each route.ts as a pattern over its address, from paths relative to src/app
 * in either separator. Sorted as Next.js matches (static, then dynamic, then
 * catch-all; then by address), so `.find` names the route that serves an
 * address: api/[...path] matches every /api address, and readdir's order
 * differs between Windows and Linux (CI).
 */
export function patternsFromRouteFiles(relativeFiles: string[]): Array<{ route: string; pattern: RegExp }> {
  return relativeFiles
    .map((file) => {
      const segments = file
        .split(/[\\/]/)
        .slice(0, -1)
        .filter((segment) => segment !== "" && segment !== "." && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
      const catchAll = segments.filter((segment) => /^\[\[?\.\.\./.test(segment)).length;
      const dynamic = segments.filter((segment) => /^\[.*\]$/.test(segment)).length - catchAll;
      const body = segments
        .map((segment) =>
          /^\[\[?\.\.\./.test(segment) ? "(?:/.*)?" : /^\[.*\]$/.test(segment) ? "/[^/]+" : `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        )
        .join("");
      return { route: `/${segments.join("/")}`, pattern: new RegExp(`^${body || "/"}/?$`), catchAll, dynamic };
    })
    .sort((a, b) => a.catchAll - b.catchAll || a.dynamic - b.dynamic || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
    .map(({ route, pattern }) => ({ route, pattern }));
}

/** Each route.ts under src/app as a pattern over its address. */
function routeHandlerPatterns(): Array<{ route: string; pattern: RegExp }> {
  return patternsFromRouteFiles(files(APP, (name) => /^route\.tsx?$/.test(name)).map((file) => path.relative(APP, file)));
}

/** A source file's text with LF endings, so a checkout with CRLF scans the same. */
function readSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
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
      for (const { kind, expression } of routerTargets(readSource(file))) {
        const hit = routeHandlerTarget(expression, patterns);
        if (hit) offenders.push(`${path.relative(SRC, file).split(/[\\/]/).join("/")}: ${kind} ${expression.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * R14-client-journey L1, R15 (all four reports): client views fetch under the
 * workspace active when they mounted. So any action that changes the ACTIVE
 * workspace ends with a full page load through afterWorkspaceChange.
 * router.refresh() re-renders only server components: after Leave it left the
 * top bar naming the old workspace, once #165 had fixed Join and delete.
 *
 * R16 (all four reports): a change that keeps the active workspace (a rename,
 * an owner making themselves a member) must not load the page again, which
 * threw away unsaved Settings typing and a freshly shown invite or connect
 * link. It ends with router.refresh() and announceWorkspaceChange(), which the
 * account menu and the workspace banner hear and read again.
 *
 * Rule: every fetch (or fetchImpl) to one of WORKSPACE_CHANGES is followed by
 * afterWorkspaceChange, and every one to WORKSPACE_ANNOUNCES by
 * announceWorkspaceChange and no full load, before the next such call in the
 * same file. Every route that sets or clears the active-workspace cookie must
 * be listed, so a new one is caught; /go is reached only by plain links, which
 * load in full already. A route held in a variable is not followed.
 */
const WORKSPACE_CHANGES: Array<{ route: string; methods: string[] }> = [
  { route: "/api/workspaces", methods: ["POST"] }, // create
  { route: "/api/workspaces/switch", methods: ["POST"] },
  { route: "/api/workspaces/leave", methods: ["POST"] },
  { route: "/api/workspaces/active", methods: ["DELETE"] }, // delete
  { route: "/api/invites/[token]/accept", methods: ["POST"] }, // join
];

/** Changes that keep the active workspace but change what the menu or the banner shows. */
const WORKSPACE_ANNOUNCES: Array<{ route: string; methods: string[] }> = [
  { route: "/api/workspaces/active", methods: ["PATCH"] }, // rename
  { route: "/api/workspaces/members/[userId]", methods: ["PATCH"] }, // a role change, one's own included
];

/**
 * Role changes that can never be the caller's own, by "file: handler". An
 * owner's own row shows "Make member", never "Make owner", so a promotion
 * always names someone else, and nothing the menu or the banner shows changes.
 */
const ANNOUNCE_NOT_NEEDED = ["components/team-section.tsx: confirmPromote"];

/** Routes that touch the cookie but are never fetched: each is reached by a full load. */
const COOKIE_ROUTES_REACHED_BY_FULL_LOAD = ["/go"];

/** Source without its comments (and with LF endings), so a comment never counts as a call. */
function withoutComments(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Each fetch in a source to one of `listed`: where it is, its route and method. */
export function workspaceChangeCalls(
  source: string,
  patterns = routeHandlerPatterns(),
  listed = WORKSPACE_CHANGES,
): Array<{ index: number; route: string; method: string }> {
  const out: Array<{ index: number; route: string; method: string }> = [];
  for (const match of source.matchAll(/\b(?:fetch|fetchImpl)\(/g)) {
    const open = match.index + match[0].length - 1;
    const call = balanced(source, open, "(", ")");
    const first = firstArgument(source, open);
    const options = call.slice(first.length + 1);
    const method = (/\bmethod:\s*["'`](\w+)["'`]/.exec(options)?.[1] ?? "GET").toUpperCase();
    for (const target of literalPaths(first)) {
      const hit = patterns.find(({ pattern }) => pattern.test(target));
      const change = hit ? listed.find((entry) => entry.route === hit.route && entry.methods.includes(method)) : undefined;
      if (change) out.push({ index: match.index, route: change.route, method });
    }
  }
  return out;
}

/** Each listed call with the code after it, up to the next listed call of either kind. */
function callsWithTheirEnding(code: string, patterns: Array<{ route: string; pattern: RegExp }>) {
  const calls = [
    ...workspaceChangeCalls(code, patterns, WORKSPACE_CHANGES).map((call) => ({ ...call, kind: "change" as const })),
    ...workspaceChangeCalls(code, patterns, WORKSPACE_ANNOUNCES).map((call) => ({ ...call, kind: "announce" as const })),
  ].sort((a, b) => a.index - b.index);
  return calls.map((call, i) => ({ ...call, ending: code.slice(call.index, calls[i + 1]?.index ?? code.length) }));
}

/** The changing calls not followed by afterWorkspaceChange before the next one. */
export function changesWithoutFullLoad(source: string, patterns = routeHandlerPatterns()): string[] {
  return callsWithTheirEnding(withoutComments(source), patterns)
    .filter((call) => call.kind === "change" && !/\bafterWorkspaceChange\b/.test(call.ending))
    .map((call) => `${call.method} ${call.route}`);
}

/** The handler a call sits in: the nearest `const name = useCallback(` or `function name(` before it. */
function enclosingHandler(code: string, index: number): string | null {
  let name: string | null = null;
  for (const match of code.slice(0, index).matchAll(/const (\w+) = useCallback\(|function (\w+)\(/g)) name = match[1] ?? match[2];
  return name;
}

/**
 * The keep-the-workspace calls that do not announce, or that load the page
 * again, before the next listed call. `notNeeded` names handlers that need no
 * announce; the no-reload rule holds for them too.
 */
export function announcesMissing(source: string, patterns = routeHandlerPatterns(), notNeeded: string[] = []): string[] {
  const code = withoutComments(source);
  return callsWithTheirEnding(code, patterns)
    .filter((call) => call.kind === "announce")
    .flatMap((call) => {
      const label = `${call.method} ${call.route}`;
      if (/\bafterWorkspaceChange\b|\blocation\.(?:reload|assign|replace)\b/.test(call.ending)) return [`${label}: loads the page again`];
      const handler = enclosingHandler(code, call.index);
      if (handler && notNeeded.includes(handler)) return [];
      return /\bannounceWorkspaceChange\(\)/.test(call.ending) ? [] : [`${label}: no announce`];
    });
}

describe("a full page load after the workspaces change", () => {
  const patterns = routeHandlerPatterns();
  const read = (relative: string) => readSource(path.join(SRC, relative));
  /** The bodies of `async function name(` and `const name = useCallback(async () =>`, in file order. */
  const bodies = (source: string, name: string) => {
    const out: string[] = [];
    const start = new RegExp(`async function ${name}\\(|const ${name} = useCallback\\(async \\(\\) =>`, "g");
    for (const match of source.matchAll(start)) {
      out.push(balanced(source, source.indexOf("{", match.index + match[0].length - 1), "{", "}"));
    }
    expect(out.length, name).toBeGreaterThan(0);
    return out;
  };

  // CI #167: on Linux readdir listed api/[...path] first and every /api address
  // matched it, so the scan found no call. The patterns must not depend on the
  // separator or the order the files come in.
  it("builds the same patterns from Linux and Windows paths, in any order", () => {
    const linux = ["api/[...path]/route.ts", "api/invites/[token]/accept/route.ts", "api/workspaces/route.ts", "api/workspaces/leave/route.ts", "go/route.ts"];
    const windows = [...linux].reverse().map((file) => file.split("/").join("\\"));
    const shape = (list: Array<{ route: string; pattern: RegExp }>) => list.map(({ route, pattern }) => `${route} ${pattern.source}`);
    expect(shape(patternsFromRouteFiles(windows))).toEqual(shape(patternsFromRouteFiles(linux)));
    const built = patternsFromRouteFiles(windows);
    const served = (address: string) => built.find(({ pattern }) => pattern.test(address))?.route;
    expect(served("/api/invites/x/accept")).toBe("/api/invites/[token]/accept");
    expect(served("/api/workspaces")).toBe("/api/workspaces");
    expect(served("/api/workspaces/leave")).toBe("/api/workspaces/leave");
    expect(served("/api/nothing-here")).toBe("/api/[...path]");
    expect(served("/go")).toBe("/go");
    // A CRLF source scans as its LF twin.
    const lf = ['await fetch("/api/workspaces/leave", {', '  method: "POST",', "});", "// afterWorkspaceChange();", ""].join("\n");
    expect(changesWithoutFullLoad(lf, patterns)).toEqual(["POST /api/workspaces/leave"]);
    expect(changesWithoutFullLoad(lf.split("\n").join("\r\n"), patterns)).toEqual(["POST /api/workspaces/leave"]);
  });

  it("each listed change is a route handler with that method", () => {
    for (const { route, methods } of [...WORKSPACE_CHANGES, ...WORKSPACE_ANNOUNCES]) {
      const source = readSource(path.join(APP, ...route.split("/").filter(Boolean), "route.ts"));
      for (const method of methods) {
        expect(source, `${method} ${route}`).toMatch(new RegExp(`export (?:async function|const) ${method}\\b`));
      }
    }
  });

  it("every route that sets or clears the active-workspace cookie is listed", () => {
    const listed = new Set([...WORKSPACE_CHANGES.map((entry) => entry.route), ...COOKIE_ROUTES_REACHED_BY_FULL_LOAD]);
    const cookieRoutes = files(APP, (name) => /^route\.tsx?$/.test(name))
      .filter((file) => readSource(file).includes("ACTIVE_WORKSPACE_COOKIE"))
      .map((file) => `/${path.relative(APP, path.dirname(file)).split(/[\\/]/).join("/")}`);
    expect(cookieRoutes.length).toBeGreaterThan(0);
    expect(cookieRoutes.filter((route) => !listed.has(route))).toEqual([]);
  });

  it("the scan finds each shape and wants a full load after each call", () => {
    const shapes: Array<[string, string[]]> = [
      ['await fetch("/api/workspaces/leave", { method: "POST" }); router.refresh();', ["POST /api/workspaces/leave"]],
      ['await fetch("/api/workspaces/active", {\n  method: "PATCH",\n});\nafterWorkspaceChange();', []],
      ['await fetchImpl(`/api/invites/${token}/accept`, { method: "POST" });', ["POST /api/invites/[token]/accept"]],
      // The menu's reads change nothing.
      ['await fetch("/api/workspaces"); await fetch("/api/workspaces/status");', []],
      // One full load after the second of two calls covers only the second.
      [
        'await fetch("/api/workspaces/switch", { method: "POST" });\nawait fetch("/api/workspaces", { method: "POST" });\nafterWorkspaceChange("/");',
        ["POST /api/workspaces/switch"],
      ],
      // A comment is not a call.
      ['await fetch("/api/workspaces/active", { method: "DELETE" });\n// afterWorkspaceChange("/");', ["DELETE /api/workspaces/active"]],
    ];
    for (const [shape, missing] of shapes) {
      expect(changesWithoutFullLoad(shape, patterns), shape).toEqual(missing);
    }
  });

  it("the scan wants an announce and no full load after a rename or a role change", () => {
    const shapes: Array<[string, string[]]> = [
      ['await fetch("/api/workspaces/active", { method: "PATCH" });\nrouter.refresh();\nannounceWorkspaceChange();', []],
      ['await fetch("/api/workspaces/active", { method: "PATCH" });\nrouter.refresh();', ["PATCH /api/workspaces/active: no announce"]],
      // R16 L1: the reload threw away unsaved typing and a fresh invite link.
      ['await fetch("/api/workspaces/active", { method: "PATCH" });\nafterWorkspaceChange();', ["PATCH /api/workspaces/active: loads the page again"]],
      [
        'await fetch("/api/workspaces/active", { method: "PATCH" });\nannounceWorkspaceChange();\nwindow.location.reload();',
        ["PATCH /api/workspaces/active: loads the page again"],
      ],
      ['await fetch(`/api/workspaces/members/${id}`, { method: "PATCH" });', ["PATCH /api/workspaces/members/[userId]: no announce"]],
      // Removing someone changes nothing the menu shows; a read is not a change.
      ['await fetch(`/api/workspaces/members/${id}`, { method: "DELETE" }); await fetch("/api/workspaces/active");', []],
      // An announce before the next call covers only the call before it.
      [
        'await fetch("/api/workspaces/active", { method: "PATCH" });\nawait fetch(`/api/workspaces/members/${id}`, { method: "PATCH" });\nannounceWorkspaceChange();',
        ["PATCH /api/workspaces/active: no announce"],
      ],
      // A comment is not an announce.
      ['await fetch("/api/workspaces/active", { method: "PATCH" });\n// announceWorkspaceChange();', ["PATCH /api/workspaces/active: no announce"]],
    ];
    for (const [shape, missing] of shapes) {
      expect(announcesMissing(shape, patterns), shape).toEqual(missing);
      expect(changesWithoutFullLoad(shape, patterns), shape).toEqual([]);
    }
    const promote = 'const confirmPromote = useCallback(async () => {\n  await fetch(`/api/workspaces/members/${id}`, { method: "PATCH" });\n});';
    expect(announcesMissing(promote, patterns, ["confirmPromote"])).toEqual([]);
    expect(announcesMissing(promote, patterns, ["confirmDemote"])).toEqual(["PATCH /api/workspaces/members/[userId]: no announce"]);
  });

  it("no file under src changes workspaces without a full load or an announce after it", () => {
    const covered: string[] = [];
    const announced: string[] = [];
    const offenders: string[] = [];
    for (const file of files(SRC, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))) {
      const source = readSource(file);
      const relative = path.relative(SRC, file).split(/[\\/]/).join("/");
      for (const call of workspaceChangeCalls(withoutComments(source), patterns)) {
        covered.push(`${relative}: ${call.method} ${call.route}`);
      }
      for (const call of workspaceChangeCalls(withoutComments(source), patterns, WORKSPACE_ANNOUNCES)) {
        announced.push(`${relative}: ${call.method} ${call.route}`);
      }
      for (const missing of changesWithoutFullLoad(source, patterns)) offenders.push(`${relative}: ${missing}`);
      const notNeeded = ANNOUNCE_NOT_NEEDED.filter((entry) => entry.startsWith(`${relative}: `)).map((entry) => entry.slice(relative.length + 2));
      for (const missing of announcesMissing(source, patterns, notNeeded)) offenders.push(`${relative}: ${missing}`);
    }
    expect(offenders).toEqual([]);
    // The rename, the promotion (exempt) and the demotion; a new caller shows up here for review.
    expect(announced.sort()).toEqual(
      [
        "components/team-section.tsx: PATCH /api/workspaces/active",
        "components/team-section.tsx: PATCH /api/workspaces/members/[userId]",
        "components/team-section.tsx: PATCH /api/workspaces/members/[userId]",
      ].sort(),
    );
    // What the rule covers today; a new caller shows up here for review.
    expect(covered.sort()).toEqual(
      [
        "app/join/[token]/join-view.tsx: POST /api/invites/[token]/accept",
        "app/workspaces/open-workspace-button.tsx: POST /api/workspaces/switch",
        "components/shell/account-menu.tsx: POST /api/workspaces",
        "components/shell/account-menu.tsx: POST /api/workspaces/switch",
        "components/team-section.tsx: DELETE /api/workspaces/active",
        "components/team-section.tsx: POST /api/workspaces/leave",
        "components/team-section.tsx: POST /api/workspaces/leave",
      ].sort(),
    );
  });

  it("Join, delete and Open land on the dashboard, a new workspace on Settings", () => {
    const join = read(path.join("app", "join", "[token]", "join-view.tsx"));
    expect(bodies(join, "handleJoin")[0]).toContain("load: afterWorkspaceChange");
    expect(bodies(join, "handleJoin")[0]).not.toMatch(/router\./);
    expect(join).toContain('ui.load("/")');
    const remove = bodies(read(path.join("components", "team-section.tsx")), "handleDelete")[0];
    expect(remove).toContain('afterWorkspaceChange("/")');
    expect(remove).not.toMatch(/router\./);
    const menu = read(path.join("components", "shell", "account-menu.tsx"));
    expect(bodies(menu, "handleCreateWorkspace")[0]).toContain('afterWorkspaceChange("/settings")');
    expect(bodies(read(path.join("app", "workspaces", "open-workspace-button.tsx")), "handleOpen")[0]).toContain(
      'afterWorkspaceChange("/")',
    );
  });

  // R15: a member of A and B leaves B -> the page loads again and the menu,
  // reading its list afresh, names A; a paused workspace left -> the banner's
  // fresh status has no banner. R16: the page loads without A's one-time
  // message (afterWorkspaceChange.test.ts).
  it("Leave (member and owner views) and the menu's switch load the page they were on", () => {
    const team = read(path.join("components", "team-section.tsx"));
    const leaves = bodies(team, "handleLeave");
    expect(leaves).toHaveLength(2);
    const handlers = [...leaves, ...bodies(read(path.join("components", "shell", "account-menu.tsx")), "handleSwitch")];
    for (const handler of handlers.map(withoutComments)) {
      expect(handler).toContain("afterWorkspaceChange()");
      expect(handler).not.toMatch(/router\./);
    }
  });

  // R16 L1: a rename keeps typed brand voice and a fresh invite or connect link
  // on screen (no load), and the menu shows the new name. R16 L2: an owner who
  // makes themselves a member gets the member banner.
  it("rename and self-demotion refresh in place and announce", () => {
    const team = read(path.join("components", "team-section.tsx"));
    const rename = withoutComments(bodies(team, "handleSaveName")[0]);
    const demote = withoutComments(bodies(team, "confirmDemote")[0]);
    const selfAt = demote.indexOf("if (demoteTarget.userId === currentUserId)");
    expect(selfAt).toBeGreaterThan(-1);
    const self = balanced(demote, demote.indexOf("{", selfAt), "{", "}");
    for (const handler of [rename, self]) {
      expect(handler).toContain("router.refresh()");
      expect(handler).toContain("announceWorkspaceChange()");
      expect(handler).not.toMatch(/afterWorkspaceChange|location\./);
    }
    // The Settings cards survive the refresh: keyed by the workspace, never its name.
    const settings = read(path.join("app", "settings", "page.tsx"));
    expect(settings).toMatch(/<SettingsForm\s+key=\{context\.workspace\.id\}/);
    expect(settings).toMatch(/<TeamSection\s+key=\{context\.workspace\.id\}/);
    expect(settings).toContain("key={`connect-link-${context.workspace.id}`}");
    // Both listen: the menu reads /api/workspaces again, the banner /api/workspaces/status.
    expect(withoutComments(read(path.join("components", "shell", "account-menu.tsx")))).toMatch(/useEffect\([^]*?watchWorkspaceList\(/);
    expect(withoutComments(read(path.join("components", "shell", "workspace-paused-banner.tsx")))).toMatch(
      /useEffect\([^]*?watchWorkspaceStatus\(/,
    );
  });
});
