import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// R26 LL3 item 3: Activity's Load more shows the hook's failure under the button.
describe("Load more in Activity", () => {
  const source = readFileSync(fileURLToPath(new URL("./activity-view.tsx", import.meta.url)), "utf8");

  it("shows loadMoreError in a status line under the button", () => {
    expect(source).toContain("loadMoreError");
    expect(source).toMatch(/role="status"[^>]*>\s*\{loadMoreError\}/);
  });
});
