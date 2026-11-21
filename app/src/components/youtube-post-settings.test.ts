import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { YouTubePostSettings } from "./youtube-post-settings";

// R65 review L1: Create locks YouTube's settings during a waiting send through
// this prop, with no wrapper around the card.
describe("YouTubePostSettings - disabled", () => {
  const html = (disabled?: boolean) =>
    renderToStaticMarkup(
      createElement(YouTubePostSettings, {
        metadata: { privacyStatus: "unlisted" },
        onChange: () => {},
        ...(disabled === undefined ? {} : { disabled }),
      } as Parameters<typeof YouTubePostSettings>[0]),
    );
  const select = (markup: string) => markup.match(/<select[^>]*>/)?.[0] ?? "";

  it("with disabled: the privacy select is disabled", () => {
    expect(select(html(true))).toContain('id="youtube-privacy"');
    expect(select(html(true))).toContain('disabled=""');
  });

  it("without disabled: as now", () => {
    for (const markup of [html(), html(false)]) {
      expect(select(markup)).toContain('id="youtube-privacy"');
      expect(select(markup)).not.toContain(" disabled=\"\"");
    }
  });
});
