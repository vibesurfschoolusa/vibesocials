import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createAnnouncer, shouldAnnounce } from "./announcer";

/**
 * R30 PP2 (lead): an info or success Alert, or a labelled Spinner, rendered
 * only sometimes was added already filled as its own role="status", so a
 * screen reader might not read it (27 Alert sites). One announcer cures them
 * all: one live region on every page, and Alert and Spinner announce their
 * text through it. Pure rules and source checks: vitest has no DOM.
 */
describe("shouldAnnounce", () => {
  it("an element in the page's first render is not read out", () => {
    expect(shouldAnnounce({ pageReady: false, last: undefined, text: "Saved." })).toBe(false);
  });

  it("an element added after the first render is read out", () => {
    expect(shouldAnnounce({ pageReady: true, last: undefined, text: "Saved." })).toBe(true);
  });

  it("a text change is read out, even on an element from the first render", () => {
    expect(shouldAnnounce({ pageReady: true, last: "Loading", text: "Saved." })).toBe(true);
    expect(shouldAnnounce({ pageReady: false, last: "Loading", text: "Saved." })).toBe(true);
  });

  it("the same text again on the same element, or no text, says nothing", () => {
    expect(shouldAnnounce({ pageReady: true, last: "Saved.", text: "Saved." })).toBe(false);
    expect(shouldAnnounce({ pageReady: true, last: undefined, text: "" })).toBe(false);
    expect(shouldAnnounce({ pageReady: true, last: "Saved.", text: "  " })).toBe(false);
  });
});

describe("createAnnouncer", () => {
  function world() {
    const texts: string[] = [];
    const timers: Array<() => void> = [];
    const clear = vi.fn();
    const announce = createAnnouncer(
      (text) => texts.push(text),
      (run) => {
        timers.push(run);
        return timers.length;
      },
      clear,
    );
    return { texts, timers, clear, announce };
  }

  it("clears the region, then sets the text on a later tick, so repeating a text reads it again", () => {
    const w = world();
    w.announce("Saved.");
    expect(w.texts).toEqual([""]);
    w.timers[0]();
    expect(w.texts).toEqual(["", "Saved."]);
    w.announce("Saved.");
    w.timers[1]();
    expect(w.texts).toEqual(["", "Saved.", "", "Saved."]);
  });

  it("a newer announcement replaces one still waiting", () => {
    const w = world();
    w.announce("First");
    w.announce("Second");
    expect(w.clear).toHaveBeenCalledWith(1);
    w.timers[1]();
    expect(w.texts.at(-1)).toBe("Second");
  });

  it("ignores empty text", () => {
    const w = world();
    w.announce("   ");
    expect(w.texts).toEqual([]);
    expect(w.timers).toEqual([]);
  });
});

describe("the announcer's wiring", () => {
  const src = path.join(__dirname, "..");
  const read = (file: string) => readFileSync(path.join(src, file), "utf8");

  it("the root layout wraps every page (shell, /c, /u, /v) in the provider", () => {
    const layout = read("app/layout.tsx").replace(/\s+/g, " ");
    expect(layout).toMatch(/<AnnouncerProvider> <AppSessionProvider>[\s\S]*<\/AppSessionProvider> <\/AnnouncerProvider>/);
  });

  it("the provider renders one always-present, visually hidden polite region", () => {
    const provider = read("components/ui/announcer.tsx");
    expect(provider).toMatch(/<div aria-live="polite" aria-atomic="true" className="sr-only">\s*\{text\}\s*<\/div>/);
    // Before the first render is committed and after every page change, nothing is read out.
    expect(provider).toMatch(/useEffect\(\(\) => \{\s+ready\.current = true;\s+return \(\) => \{\s+ready\.current = false;\s+\};\s+\}, \[pathname\]\);/);
    // Without a provider (unit tests) announcing does nothing.
    expect(provider).toContain("if (!announcer || !enabled) return;");
  });

  it("Alert's status variants have no role of their own and announce instead; warning and danger stay alerts", () => {
    const alert = read("components/ui/alert.tsx");
    expect(alert).not.toMatch(/role: "status"/);
    expect(alert.match(/role: "alert",/g)).toHaveLength(2);
    expect(alert).toMatch(/useAnnounceOnShow\(\(\) => own\.current\?\.textContent \?\? "", meta\.role === null && !\("role" in props\)\)/);
  });

  it("a labelled Spinner is an image with a name and announces its label", () => {
    const spinner = read("components/ui/spinner.tsx");
    expect(spinner).not.toContain('"status"');
    expect(spinner).toMatch(/role=\{label \? "img" : undefined\}/);
    expect(spinner).toMatch(/useAnnounceOnShow\(\(\) => label \?\? "", Boolean\(label\)\)/);
  });
});
