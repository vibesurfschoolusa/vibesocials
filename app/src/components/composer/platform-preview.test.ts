import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlatformPreviewList } from "./platform-preview";

const render = (mediaCount?: number) =>
  renderToStaticMarkup(
    createElement(PlatformPreviewList, {
      platforms: ["instagram"],
      caption: "hello",
      mediaUrl: "blob:cover",
      mediaMimeType: "image/jpeg",
      mediaCount,
    }),
  );

describe("PlatformPreviewList photo count", () => {
  it("shows the first photo with no badge for one photo", () => {
    expect(render()).toContain('src="blob:cover"');
    expect(render()).not.toContain("photos");
    expect(render(1)).toBe(render());
  });

  it("shows a count badge for several photos", () => {
    const html = render(4);
    expect(html).toContain('src="blob:cover"');
    expect(html).toContain('aria-label="4 photos"');
    expect(html).toContain(">4</span>");
  });
});
