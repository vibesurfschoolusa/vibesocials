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

/** The address parameters a page or component source reads by name. */
function paramsRead(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/searchParams\.get\(\s*["'](\w+)["']/g)) names.add(match[1]);
  for (const match of source.matchAll(/searchParams\??:\s*Promise<\{([^}]*)\}>/g)) {
    for (const key of match[1].matchAll(/(\w+)\??:/g)) names.add(key[1]);
  }
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*\(?\s*await\s+searchParams/g)) {
    for (const key of match[1].split(",")) if (key.trim()) names.add(key.trim().split(/[\s:=]/)[0]);
  }
  return [...names].sort();
}

describe("every parameter a page reads is sorted", () => {
  it("the scan reads each shape", () => {
    expect(paramsRead('const a = searchParams.get("choose");')).toEqual(["choose"]);
    expect(paramsRead("searchParams: Promise<{\n error?: string;\n same_end?: string;\n}>")).toEqual(["error", "same_end"]);
    expect(paramsRead("const { notice } = (await searchParams) ?? {};")).toEqual(["notice"]);
    expect(paramsRead("const { month } = await searchParams;")).toEqual(["month"]);
  });

  it("is one-time or kept", () => {
    const sorted = new Set<string>([...ONE_TIME_PARAMS, ...Object.keys(ONE_TIME_VALUES), ...KEPT_PARAMS]);
    const unsorted: string[] = [];
    const seen: string[] = [];
    // Pages and the components they render; route handlers and server code read requests, not the address bar.
    for (const file of ["app", "components", "hooks"].flatMap((dir) => sourceFiles(path.join(SRC, dir)))) {
      const relative = path.relative(SRC, file).split(/[\\/]/).join("/");
      for (const name of paramsRead(readFileSync(file, "utf8"))) {
        seen.push(name);
        if (!sorted.has(name)) unsorted.push(`${relative}: ${name}`);
      }
    }
    expect(unsorted.sort()).toEqual([]);
    // The scan finds the Settings and dashboard messages at all.
    for (const name of ["success", "error", "billing", "notice", "choose", "linkedin_setup", "mediaItemId", "media"]) expect(seen).toContain(name);
  });
});
