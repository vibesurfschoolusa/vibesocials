import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installThemeSync } from "./theme-toggle";

/**
 * R42 new-customer L1: a theme chosen in one tab showed as pressed in another
 * open tab, which kept the old theme. The toggle is mounted only while the
 * account menu is open, so the page applies the stored theme from a listener
 * the shell installs for the whole page.
 */

let classes: Set<string>;
let stored: Record<string, string>;
let listeners: Map<string, Set<(event: { key: string | null }) => void>>;

const fakeWindow = {
  addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  },
  removeEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
    listeners.get(type)?.delete(listener);
  },
};

function storageEvent(key: string | null) {
  for (const listener of listeners.get("storage") ?? []) listener({ key });
}

beforeEach(() => {
  classes = new Set(["light"]);
  stored = {};
  listeners = new Map();
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      },
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a theme chosen in another tab", () => {
  it("is applied to this page's html, with no toggle mounted", () => {
    const stop = installThemeSync();
    stored.theme = "dark";
    storageEvent("theme");
    expect([...classes]).toEqual(["dark"]);

    stored.theme = "system";
    storageEvent("theme");
    expect([...classes]).toEqual([]);

    stored.theme = "light";
    storageEvent("theme");
    expect([...classes]).toEqual(["light"]);
    stop();
  });

  it("other keys leave the theme alone; a cleared store goes back to the system theme", () => {
    const stop = installThemeSync();
    stored.theme = "dark";
    storageEvent("session");
    expect([...classes]).toEqual(["light"]);
    delete stored.theme;
    storageEvent(null);
    expect([...classes]).toEqual([]);
    stop();
  });

  it("stops listening when the page goes", () => {
    installThemeSync()();
    stored.theme = "dark";
    storageEvent("theme");
    expect([...classes]).toEqual(["light"]);
  });

  it("the shell, which wraps every route, installs it once", () => {
    const shell = readFileSync(fileURLToPath(new URL("./app-shell.tsx", import.meta.url)), "utf8");
    expect(shell).toContain("useEffect(() => installThemeSync(), []);");
  });
});
