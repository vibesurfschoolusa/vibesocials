import type { MediaItem } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { computeYouTubeTitle } from "./youtubeClient";

// 2026-11-01 audit (Task 4 item 1): the YouTube title is the POST's own base
// caption (no footer) — the job's snapshot first, the shared MediaItem's only
// as a legacy fallback — so a reused video gets the title typed for THIS post.
describe("computeYouTubeTitle", () => {
  const media = (baseCaption: string) => ({ baseCaption }) as unknown as MediaItem;

  it("uses the post's own base caption over the shared media item's", () => {
    expect(
      computeYouTubeTitle({
        baseCaption: "Typed for this post",
        mediaItem: media("Caption from the original upload"),
        caption: "Typed for this post\n\n#footer",
      }),
    ).toBe("Typed for this post");
  });

  it("falls back to the media item's caption when the post carries none (legacy jobs)", () => {
    expect(
      computeYouTubeTitle({
        baseCaption: undefined,
        mediaItem: media("Original caption"),
        caption: "Original caption\n\n#footer",
      }),
    ).toBe("Original caption");
  });

  it("falls back to the full caption when both base captions are empty", () => {
    expect(
      computeYouTubeTitle({ baseCaption: "", mediaItem: media(""), caption: "#footer only" }),
    ).toBe("#footer only");
  });

  it("truncates to YouTube's 100-grapheme title limit", () => {
    const title = computeYouTubeTitle({
      baseCaption: "a".repeat(150),
      mediaItem: media(""),
      caption: "",
    });
    expect([...title]).toHaveLength(100);
  });
});
