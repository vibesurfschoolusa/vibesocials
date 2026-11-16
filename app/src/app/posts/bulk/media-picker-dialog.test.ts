import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// R27 pages L11: the picker has nothing to upload with, so its empty state
// sends the person to this page's own file choice or to Media.
describe("Media picker with nothing in Media", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("names only controls that exist", () => {
    expect(source).toContain(
      "Nothing in Media yet. Close this and choose photos and videos on this page, or upload them on the Media page.",
    );
    expect(source).not.toContain("Upload files here");
  });
});
