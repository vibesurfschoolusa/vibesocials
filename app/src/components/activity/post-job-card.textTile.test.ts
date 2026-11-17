import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TextPostTile } from "./post-job-card";

// R45 pages-b L2: the tile's name sat on a plain span, which screen readers
// ignore. It is an image with its name, as the report's "File removed" tile.
describe("TextPostTile for screen readers", () => {
  it("names itself through role img", () => {
    expect(renderToStaticMarkup(createElement(TextPostTile))).toMatch(
      /^<span role="img" aria-label="Text post, no photo"[^>]*>Text<\/span>$/,
    );
  });
});
