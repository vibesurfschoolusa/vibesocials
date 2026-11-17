import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FIRST_LOAD_FAILED_MESSAGE,
  LOAD_MORE_FAILED_MESSAGE,
  mediaCountLine,
  mediaPageUrl,
} from "./media-picker-dialog";

// R32 publishing L1: the picker lists the library of the workspace Add many
// was drawn for; the route's refusal sentence is what it then says.
describe("Media picker and the page's workspace", () => {
  it("every page's address carries the page's id", () => {
    expect(mediaPageUrl("ws-1", null)).toBe("/api/media?workspaceId=ws-1");
    expect(mediaPageUrl("ws-1", "c 1")).toBe("/api/media?cursor=c%201&workspaceId=ws-1");
  });

  it("Add many passes its workspace", () => {
    const form = readFileSync(new URL("./bulk-posts-form.tsx", import.meta.url), "utf8");
    expect(form).toMatch(/<MediaPickerDialog\s+workspaceId=\{workspaceId\}/);
    const picker = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8");
    expect(picker).toContain("fetch(mediaPageUrl(workspaceId, cursor))");
  });
});

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
// old alert away; it is cleared as Load more starts (R31: its own line).
describe("Media picker Load more", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("clears the error before it loads the next page", () => {
    expect(source).toContain(
      "if (!nextCursor || loadingMore) return; setMoreError(null); setLoadingMore(true); const result = await fetchPage(nextCursor, LOAD_MORE_FAILED_MESSAGE);",
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

// R31 pages L1: Load more sits at the bottom of a long, scrolled grid; its
// failure was shown at the top, out of sight. It is shown under the button;
// the top line is the first load's only.
describe("Media picker: a failed Load more is shown by the button", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("Load more keeps its own error, cleared as it starts", () => {
    const more = source.slice(source.indexOf("async function loadMore()"), source.indexOf("const atLimit"));
    expect(more).toContain("setMoreError(null); setLoadingMore(true);");
    expect(more).toContain('if (typeof result === "string") setMoreError(result);');
    expect(more).not.toContain("setError(");
  });

  it("the line is under the Load more button; the top line shows only the first load's failure", () => {
    const button = source.indexOf("<LoadMoreButton ");
    expect(button).toBeGreaterThan(-1);
    const after = source.slice(button, source.indexOf("</DialogBody>"));
    expect(after).toContain('{moreError ? <p role="alert" className="text-sm text-destructive">{moreError}</p> : null}');
    expect(source).toContain('{error ? <Alert variant="danger">{error}</Alert> : null}');
  });

  it("a new opening starts without an old Load more error", () => {
    const opening = source.slice(source.indexOf("if (!open) return;"), source.indexOf("}, [open, fetchPage]);"));
    expect(opening).toContain("setMoreError(null);");
  });
});

// R34 publishing L1 / pages L1: after a stale-tab refusal Load more can only
// be refused again, so the picker uses the shared button, which then reads
// Reload page (as Queue, Activity and Media do).
describe("Media picker Load more after a workspace refusal", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("uses the shared LoadMoreButton with the kept error", () => {
    expect(source).toContain('import { LoadMoreButton } from "@/components/load-error";');
    expect(source).toContain("<LoadMoreButton error={moreError} loading={loadingMore} onLoadMore={() => void loadMore()} />");
  });

  it("has no Load more button of its own", () => {
    expect(source).not.toContain("Load more </Button>");
  });
});

// R43 pages-a L6: the skeletons are hidden from screen readers, so the picker
// says it is loading, then what it found, through AnnouncedText.
describe("Media picker says it is loading, then the result", () => {
  const source = readFileSync(new URL("./media-picker-dialog.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");

  it("the loading line and both results go through AnnouncedText", () => {
    expect(source).toContain('<AnnouncedText className="sr-only" text="Loading your media…" />');
    expect(source).toContain("<AnnouncedText className=\"text-sm text-muted-foreground\" text=\"Nothing in Media yet.");
    expect(source).toContain('<AnnouncedText className="sr-only" text={mediaCountLine(items.length)} />');
  });

  it("the list's line says how many are shown", () => {
    expect(mediaCountLine(1)).toBe("Showing 1 photo or video.");
    expect(mediaCountLine(12)).toBe("Showing 12 photos and videos.");
  });
});
