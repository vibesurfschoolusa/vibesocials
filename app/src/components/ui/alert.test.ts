import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Alert } from "./alert";

// R20 pages L2: the text column is a flex item beside the icon; without
// min-w-0 it can never be narrower than its longest word (a long email
// address), so the banner ran off the screen at 375 px.
describe("Alert text column", () => {
  it("may shrink below its longest word, for every variant", () => {
    for (const variant of ["info", "success", "warning", "danger"] as const) {
      const html = renderToStaticMarkup(createElement(Alert, { variant, title: "T" }, "Body"));
      expect(html).toMatch(/<div class="flex min-w-0 flex-col gap-1">/);
    }
  });
});
