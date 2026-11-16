import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FIRST_LOAD_FAILED_MESSAGE, LOAD_MORE_FAILED_MESSAGE } from "./media-picker-dialog";

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

// R29 publishing L4: a Load more that works after one that failed takes the
// old alert away; it is cleared as Load more starts.
describe("Media picker Load more", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("clears the error before it loads the next page", () => {
    expect(source).toContain(
      "if (!nextCursor || loadingMore) return; setError(null); setLoadingMore(true); const result = await fetchPage(nextCursor, LOAD_MORE_FAILED_MESSAGE);",
    );
  });

  // R30 pages L5: closing the picker loses the ticks, and the list and Load
  // more are still on screen, so a failed Load more says to press it again.
  it("a failed Load more says to press Load more again; the first load keeps its own sentence", () => {
    expect(LOAD_MORE_FAILED_MESSAGE).toBe("Couldn't load more. Press Load more to try again.");
    expect(FIRST_LOAD_FAILED_MESSAGE).toBe("Your media could not be loaded. Close this and try again.");
    expect(source).toContain("void fetchPage(null, FIRST_LOAD_FAILED_MESSAGE).then(");
    expect(source.split('"Your media could not be loaded. Close this and try again."')).toHaveLength(2);
  });

  it("the ticks stay when Load more fails", () => {
    const more = source.slice(source.indexOf("async function loadMore()"), source.indexOf("setLoadingMore(false);"));
    expect(more).not.toContain("setSelected(");
  });
});
