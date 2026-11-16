import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { planReturnNotice } from "@/components/planSectionView";

import { LOCATION_CLEARED_PARAM, SAME_END_PARAM } from "./differentAccount";
import { afterWorkspaceChange, ONE_TIME_PARAMS, ONE_TIME_VALUES, withoutOneTimeParams } from "./afterWorkspaceChange";

function fakeLocation(href = "https://vibesocials.test/settings") {
  return { href, assign: vi.fn(), reload: vi.fn(), replace: vi.fn() };
}

describe("afterWorkspaceChange", () => {
  // Leave stays where it was (Settings), in full.
  it("loads the current page again in full when given no address", () => {
    const location = fakeLocation();
    afterWorkspaceChange(undefined, location);
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  // Join, delete and Open land on the dashboard; a new workspace on Settings.
  it("loads the given page in full", () => {
    const location = fakeLocation();
    afterWorkspaceChange("/settings", location);
    expect(location.assign).toHaveBeenCalledWith("/settings");
    expect(location.reload).not.toHaveBeenCalled();
  });

  // R16-pages L1 = new-customer L2: switch from /settings?success=facebook_connected
  // (or leave there) lands on B's Settings without A's "Facebook connected."
  it("drops the last workspace's one-time message from the address it loads again", () => {
    const location = fakeLocation("https://vibesocials.test/settings?success=facebook_connected");
    afterWorkspaceChange(undefined, location);
    expect(location.replace).toHaveBeenCalledWith("/settings");
    expect(location.reload).not.toHaveBeenCalled();
  });

  it("keeps the rest of the address, the section included", () => {
    const location = fakeLocation("https://vibesocials.test/settings?billing=success&error=x&same_end=1#plan");
    afterWorkspaceChange(undefined, location);
    expect(location.replace).toHaveBeenCalledWith("/settings#plan");
    const activity = fakeLocation("https://vibesocials.test/activity?show=problems&notice=other-workspace");
    afterWorkspaceChange(undefined, activity);
    expect(activity.replace).toHaveBeenCalledWith("/activity?show=problems");
  });
});

describe("withoutOneTimeParams", () => {
  it("answers null when the address has no one-time parameter, so the page simply reloads", () => {
    expect(withoutOneTimeParams("https://vibesocials.test/queue")).toBeNull();
    expect(withoutOneTimeParams("https://vibesocials.test/reports?month=2026-10#top")).toBeNull();
  });

  it("drops each one-time parameter", () => {
    for (const name of ONE_TIME_PARAMS) {
      expect(withoutOneTimeParams(`https://vibesocials.test/settings?${name}=1`), name).toBe("/settings");
    }
  });

  // Coordinator: they name the previous workspace's items, which the new one can't load.
  it("drops Create's reused item and Add many's items", () => {
    expect(withoutOneTimeParams("https://vibesocials.test/posts/new?mediaItemId=m1")).toBe("/posts/new");
    expect(withoutOneTimeParams("https://vibesocials.test/posts/bulk?media=m1,m2")).toBe("/posts/bulk");
    // A file shared to the app waits in this browser, for any workspace.
    expect(withoutOneTimeParams("https://vibesocials.test/posts/new?shared=1")).toBeNull();
  });

  // Coordinator: billing is a one-time result on Settings, a view setting on Pricing.
  it("drops billing only when it carries a result", () => {
    expect(withoutOneTimeParams("https://vibesocials.test/settings?billing=success#plan")).toBe("/settings#plan");
    for (const value of ["cancel", "canceled", "cancelled"]) {
      expect(withoutOneTimeParams(`https://vibesocials.test/settings?billing=${value}`), value).toBe("/settings");
    }
    expect(withoutOneTimeParams("https://vibesocials.test/pricing?billing=year")).toBeNull();
    expect(withoutOneTimeParams("https://vibesocials.test/pricing?billing=year&success=x")).toBe("/pricing?billing=year");
  });

  it("every billing value Settings shows as a message is a result", () => {
    // planReturnNotice answers before it looks at the workspace for any other value.
    const shown = ["success", "cancel", "canceled", "cancelled", "year", "month", ""].filter(
      (value) => planReturnNotice(value, {} as never, new Date()) !== null || ONE_TIME_VALUES.billing.includes(value),
    );
    expect(shown.sort()).toEqual([...ONE_TIME_VALUES.billing].sort());
    expect(ONE_TIME_VALUES.billing).toContain("success");
  });

  it("names the Settings parameters the callbacks set", () => {
    expect(ONE_TIME_PARAMS).toContain(LOCATION_CLEARED_PARAM);
    expect(ONE_TIME_PARAMS).toContain(SAME_END_PARAM);
  });
});

/**
 * Every address parameter a page reads is either one-time (dropped on
 * a workspace change) or kept on purpose, so a new one has to be sorted here.
 */
const KEPT_PARAMS = [
  "show", // Activity's tab
  "month", // Reports' month
  "q", // search box
  "page", // page number
  "callbackUrl", // sign-in return address
  "registered", // sign-in page only, signed out
  "shared", // a file shared to the app waits in this browser, for any workspace
];

const SRC = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") && !/^route\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The text from the `{` at `start` to its matching `}`. */
function block(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** The names `holder` is read with: .get/.has/.getAll("x"), .x, ["x"], [CONSTANT], and [key] over a literal list. */
function readsThrough(source: string, holder: string, constants: Map<string, string>): string[] {
  const names: string[] = [];
  const h = holder.replace(/[$]/g, "\\$");
  for (const match of source.matchAll(new RegExp(`\\b${h}\\??\\.(?:get|has|getAll)\\(\\s*["'](\\w+)["']`, "g"))) names.push(match[1]);
  // A field, not a method: `.x` not followed by "(".
  for (const match of source.matchAll(new RegExp(`\\b${h}\\??\\.(\\w+)\\b(?!\\s*\\()`, "g"))) names.push(match[1]);
  for (const match of source.matchAll(new RegExp(`\\b${h}\\[\\s*["'](\\w+)["']\\s*\\]`, "g"))) names.push(match[1]);
  for (const match of source.matchAll(new RegExp(`\\b${h}\\[\\s*([A-Z][A-Z0-9_]*)\\s*\\]`, "g"))) {
    const value = constants.get(match[1]);
    if (value) names.push(value);
  }
  for (const loop of source.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]*)\]\s*\)/g)) {
    if (new RegExp(`\\b${h}\\[\\s*${loop[1]}\\s*\\]`).test(source)) {
      for (const literal of loop[2].matchAll(/["'](\w+)["']/g)) names.push(literal[1]);
    }
  }
  return names;
}

/**
 * The address parameters a page or component source reads by name. `library`
 * is the rest of src: the definitions of helpers it hands the params object to,
 * and the string constants it reads them with.
 */
function paramsRead(source: string, library = ""): string[] {
  const names = new Set<string>();
  const constants = new Map<string, string>();
  for (const match of `${library}\n${source}`.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'](\w+)["']/g)) {
    constants.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/searchParams\??:\s*Promise<\{([^}]*)\}>/g)) {
    for (const key of match[1].matchAll(/(\w+)\??:/g)) names.add(key[1]);
  }
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*\(?\s*await\s+searchParams/g)) {
    for (const key of match[1].split(",")) if (key.trim()) names.add(key.trim().split(/[\s:=]/)[0]);
  }
  for (const match of source.matchAll(/\(\s*await\s+searchParams\s*\)\s*\??\.(\w+)/g)) names.add(match[1]);
  // Every name the params object is held under: the prop, useSearchParams(), `await searchParams`.
  const holders = new Set(["searchParams"]);
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*(?:useSearchParams\(\)|\(?\s*await\s+searchParams\b)/g)) holders.add(match[1]);
  for (const holder of holders) {
    for (const name of readsThrough(source, holder, constants)) if (holder !== "searchParams" || name !== "then") names.add(name);
    // A helper handed the params object reads them under its own parameter name.
    for (const call of source.matchAll(new RegExp(`\\b(\\w+)\\(\\s*${holder}\\s*[,)]`, "g"))) {
      const definition = new RegExp(`function\\s+${call[1]}\\s*\\(\\s*(\\w+)`).exec(library);
      if (!definition) continue;
      // The body opens after the parameter list, whose defaults may hold braces of their own.
      let depth = 0;
      let close = definition.index + definition[0].indexOf("(");
      for (; close < library.length; close += 1) {
        if (library[close] === "(") depth += 1;
        else if (library[close] === ")" && --depth === 0) break;
      }
      const body = block(library, library.indexOf("{", close));
      const aliases = [definition[1]];
      for (const alias of body.matchAll(new RegExp(`const\\s+(\\w+)\\s*=[^;]*\\b${definition[1]}\\b`, "g"))) aliases.push(alias[1]);
      for (const alias of aliases) for (const name of readsThrough(body, alias, constants)) names.add(name);
    }
  }
  return [...names].sort();
}

describe("every parameter a page reads is sorted", () => {
  it("the scan reads each shape", () => {
    expect(paramsRead('const a = searchParams.get("choose");')).toEqual(["choose"]);
    expect(paramsRead("searchParams: Promise<{\n error?: string;\n same_end?: string;\n}>")).toEqual(["error", "same_end"]);
    expect(paramsRead("const { notice } = (await searchParams) ?? {};")).toEqual(["notice"]);
    expect(paramsRead("const { month } = await searchParams;")).toEqual(["month"]);
    expect(paramsRead("const media = (await searchParams)?.media;")).toEqual(["media"]);
  });

  // Review note: a read through any name the params object is held under.
  it("reads through a variable bound to useSearchParams() or searchParams", () => {
    expect(paramsRead('const q = useSearchParams();\nconst id = q.get("x");\nif (q.has("y")) q.toString();')).toEqual(["x", "y"]);
    const page = [
      "const params = await searchParams;",
      "describe({ error: params.error ?? null });",
      'if (params["same_end"] !== undefined && params[CLEARED] !== undefined) {}',
    ].join("\n");
    expect(paramsRead(page, 'export const CLEARED = "location_cleared";')).toEqual(["error", "location_cleared", "same_end"]);
    const loop = 'const query = await searchParams;\nfor (const key of ["error", "linkedin_setup"]) {\n  const value = first(query[key]);\n}';
    expect(paramsRead(loop)).toEqual(["error", "linkedin_setup"]);
  });

  // Review note: a lib helper given the params object reads them itself.
  it("reads through a helper the params object is handed to", () => {
    const view = "const searchParams = useSearchParams();\nconst tab = tabFrom(searchParams);";
    const helper = [
      "export function tabFrom(search: string | URLSearchParams): string {",
      '  const params = typeof search === "string" ? new URLSearchParams(search) : search;',
      '  return params.get("tab") ?? "all";',
      "}",
    ].join("\n");
    expect(paramsRead(view, helper)).toEqual(["tab"]);
    const bound = 'const q = useSearchParams();\nconst result = describeResult(q, { kept: true });';
    const direct = 'export function describeResult(query: URLSearchParams, options = {}) {\n  return query.get("outcome");\n}';
    expect(paramsRead(bound, direct)).toEqual(["outcome"]);
    // No definition found: nothing is invented.
    expect(paramsRead("const q = useSearchParams();\nunknownHelper(q);")).toEqual([]);
  });

  it("is one-time or kept", () => {
    const sorted = new Set<string>([...ONE_TIME_PARAMS, ...Object.keys(ONE_TIME_VALUES), ...KEPT_PARAMS]);
    const unsorted: string[] = [];
    const seen: string[] = [];
    // Helpers and constants can live anywhere in src.
    const library = sourceFiles(SRC)
      .sort()
      .map((file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
      .join("\n");
    // Pages and the components they render; route handlers and server code read requests, not the address bar.
    for (const file of ["app", "components", "hooks"].flatMap((dir) => sourceFiles(path.join(SRC, dir)))) {
      const relative = path.relative(SRC, file).split(/[\\/]/).join("/");
      for (const name of paramsRead(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), library)) {
        seen.push(name);
        if (!sorted.has(name)) unsorted.push(`${relative}: ${name}`);
      }
    }
    expect(unsorted.sort()).toEqual([]);
    // The scan finds the Settings and dashboard messages at all.
    for (const name of ["success", "error", "billing", "notice", "choose", "linkedin_setup", "mediaItemId", "media"]) expect(seen).toContain(name);
  });
});
