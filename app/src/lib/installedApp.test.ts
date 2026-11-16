import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isInstalledApp } from "./installedApp";

const win = (standaloneMedia: boolean, navigatorStandalone?: boolean, withMatchMedia = true) =>
  ({
    ...(withMatchMedia
      ? { matchMedia: (query: string) => ({ matches: standaloneMedia && query === "(display-mode: standalone)" }) }
      : {}),
    navigator: navigatorStandalone === undefined ? {} : { standalone: navigatorStandalone },
  }) as unknown as Window;

// LL2 lead follow-up: one rule for "this page runs as the installed app", with
// no dependencies, for the signed-out line and the Google sign-in link alike.
describe("isInstalledApp", () => {
  it("display-mode standalone, or iOS's navigator.standalone", () => {
    expect(isInstalledApp(win(true))).toBe(true);
    expect(isInstalledApp(win(false, true))).toBe(true);
    expect(isInstalledApp(win(false, false))).toBe(false);
    expect(isInstalledApp(win(false))).toBe(false);
  });

  it("no window, or one without matchMedia, is a browser tab unless iOS says otherwise", () => {
    expect(isInstalledApp(undefined)).toBe(false);
    expect(isInstalledApp(win(false, undefined, false))).toBe(false);
    expect(isInstalledApp(win(false, true, false))).toBe(true);
  });

  it("imports nothing", () => {
    const source = readFileSync(path.join(__dirname, "installedApp.ts"), "utf8");
    expect(source).not.toMatch(/^import /m);
  });

  it("is the one rule: both callers import it and neither repeats it", () => {
    for (const file of ["../components/shell/signed-out-alert.tsx", "../components/gbp-sign-in-link.tsx"]) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      expect(source, file).toContain('import { isInstalledApp } from "@/lib/installedApp";');
      expect(source, file).not.toContain("display-mode: standalone");
    }
    const link = readFileSync(path.join(__dirname, "../components/gbp-sign-in-link.tsx"), "utf8");
    expect(link).not.toContain("signed-out-alert");
  });
});
