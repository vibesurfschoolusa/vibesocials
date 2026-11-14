import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SECTION_LINE_PX, SettingsSectionNav, sectionInView } from "./settings-section-nav";

const ids = ["post-defaults", "posting-times", "connections", "usage", "account"];

function tops(...values: number[]) {
  return ids.map((id, i) => ({ id, top: values[i] }));
}

describe("sectionInView", () => {
  it("marks the first section at the top of the page", () => {
    expect(sectionInView(tops(200, 900, 1600, 2300, 3000), false)).toBe("post-defaults");
  });

  it("marks the last heading that has passed the line under the sticky bars", () => {
    expect(sectionInView(tops(-900, -200, SECTION_LINE_PX, 700, 1400), false)).toBe("connections");
    expect(sectionInView(tops(-900, -200, SECTION_LINE_PX + 1, 700, 1400), false)).toBe("posting-times");
  });

  // Landing on /settings#connections leaves its heading at the scroll margin (80 or 128 px).
  it("marks a section whose heading sits at the scroll margin after a jump", () => {
    expect(sectionInView(tops(-1500, -800, 128, 830, 1530), false)).toBe("connections");
    expect(sectionInView(tops(-1500, -800, 80, 780, 1480), false)).toBe("connections");
  });

  it("marks the last section at the bottom of the page, even when its heading cannot reach the line", () => {
    expect(sectionInView(tops(-3000, -2300, -1600, -100, 400), true)).toBe("account");
  });

  it("returns null with no sections", () => {
    expect(sectionInView([], false)).toBeNull();
  });
});

describe("SettingsSectionNav", () => {
  const sections = [
    { id: "post-defaults", label: "Posts and emails" },
    { id: "connections", label: "Connections" },
  ];

  it("renders one link per section, to its anchor, with the first marked as current", () => {
    const html = renderToStaticMarkup(createElement(SettingsSectionNav, { sections }));
    const links = [...html.matchAll(/<a href="#([^"]+)"([^>]*)>([^<]+)<\/a>/g)].map((m) => ({
      id: m[1],
      current: m[2].includes('aria-current="location"'),
      text: m[3],
    }));
    expect(links).toEqual([
      { id: "post-defaults", current: true, text: "Posts and emails" },
      { id: "connections", current: false, text: "Connections" },
    ]);
  });

  it("stays in view under the top bar and scrolls sideways when the row does not fit", () => {
    const html = renderToStaticMarkup(createElement(SettingsSectionNav, { sections }));
    expect(html).toMatch(/<nav aria-label="Settings sections" class="[^"]*\bsticky\b[^"]*\btop-16\b/);
    expect(html).toMatch(/<ul class="[^"]*\boverflow-x-auto\b[^"]*\blg:flex-col\b/);
  });
});
