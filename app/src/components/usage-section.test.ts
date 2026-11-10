import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsageSection } from "./usage-section";

const MB = 1024 * 1024;

describe("UsageSection", () => {
  it("shows one line when usage could not be read", () => {
    const html = renderToStaticMarkup(createElement(UsageSection, { usage: null }));

    expect(html).toContain("Usage is not available right now.");
    expect(html).not.toContain(" of ");
  });

  it("shows used of limit for all four", () => {
    const html = renderToStaticMarkup(
      createElement(UsageSection, {
        usage: {
          postsToday: { used: 3, limit: 20, resetsAt: new Date("2026-11-11T00:00:00Z") },
          xPostsThisMonth: { used: 4, limit: 30, resetsAt: new Date("2026-12-01T00:00:00Z") },
          youtubeUploadsToday: { used: 1, limit: 10, resetsAt: new Date("2026-11-11T08:00:00Z") },
          storage: { used: 512 * MB, limit: 5120 * MB, resetsAt: null },
        },
      }),
    );

    expect(html).toContain("3 of 20");
    expect(html).toContain("4 of 30");
    expect(html).toContain("1 of 10");
    expect(html).toContain("0.5 GB of 5.0 GB");
    expect(html).toContain("Starts again on 1 December.");
  });
});
