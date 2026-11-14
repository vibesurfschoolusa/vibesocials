import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  cancelRequest,
  coverEditNote,
  coverLabel,
  emptyCaptionMessage,
  isTextPost,
  seriesLabel,
  sortQueue,
} from "./queue-view";

function job(id: string, overrides: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id,
    status: "draft",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: null,
    caption: id,
    platformCaptions: null,
    results: [],
    media: null,
    mediaCount: 1,
    publish: null,
    createdBy: null,
    approvalState: "none",
    ...overrides,
  };
}

describe("sortQueue", () => {
  it("puts drafts the client asked to change above everything else, oldest request first", () => {
    const sorted = sortQueue([
      job("pending", { approvalState: "pending", createdAt: "2026-10-01T00:00:00.000Z" }),
      job("scheduled", { status: "scheduled", scheduledFor: "2026-11-02T00:00:00.000Z" }),
      job("change-new", { clientChangeRequestedAt: "2026-11-09T00:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" }),
      job("plain-draft", { createdAt: "2026-11-08T00:00:00.000Z" }),
      job("change-old", { clientChangeRequestedAt: "2026-11-08T00:00:00.000Z", createdAt: "2026-10-02T00:00:00.000Z" }),
    ]);

    expect(sorted.map((j) => j.id)).toEqual(["change-old", "change-new", "pending", "scheduled", "plain-draft"]);
  });

  it("does not lift a scheduled post that still carries old marks", () => {
    const sorted = sortQueue([
      job("scheduled", { status: "scheduled", scheduledFor: "2026-11-02T00:00:00.000Z", clientChangeRequestedAt: "2026-11-01T00:00:00.000Z" }),
      job("pending", { approvalState: "pending" }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["pending", "scheduled"]);
  });
});

describe("seriesLabel", () => {
  it("reads Repeats: 3 of 8 for a post in a series, and nothing otherwise", () => {
    expect(seriesLabel(job("a", { seriesId: "s1", seriesPosition: 3, seriesCount: 8 }))).toBe("Repeats: 3 of 8");
    expect(seriesLabel(job("b", { seriesId: null }))).toBeNull();
    expect(seriesLabel(job("c"))).toBeNull();
  });
});

// V1 fix round 1: a post with a chosen video cover says so.
describe("coverLabel and coverEditNote", () => {
  it("say a post has a custom cover, and nothing for one without", () => {
    expect(coverLabel(job("a", { hasCover: true }))).toBe("Custom cover");
    expect(coverEditNote(job("a", { hasCover: true }))).toBe("Keeps its custom cover.");
    expect(coverLabel(job("b", { hasCover: false }))).toBeNull();
    expect(coverEditNote(job("c"))).toBeNull();
  });
});

describe("cancelRequest", () => {
  it("cancels one post through the single cancel, and the rest of a series through cancel-series", () => {
    expect(cancelRequest(job("a", { seriesId: "s1" }), "one")).toEqual({
      url: "/api/posts/a/cancel",
      series: false,
    });
    expect(cancelRequest(job("a", { seriesId: "s1" }), "rest")).toEqual({
      url: "/api/posts/a/cancel-series",
      series: true,
    });
    // A post without a series can only be cancelled on its own.
    expect(cancelRequest(job("b"), "rest")).toEqual({ url: "/api/posts/b/cancel", series: false });
  });
});

describe("a post without a file in the Queue", () => {
  it("is a text post when it has no media and no files", () => {
    expect(isTextPost(job("t", { media: null, mediaCount: 0 }))).toBe(true);
    expect(isTextPost(job("f", { media: { url: "https://blob.example.com/a.jpg", mimeType: "image/jpeg" } }))).toBe(false);
    // A post whose file row is gone still counts its file: it is not a text post.
    expect(isTextPost(job("gone", { media: null, mediaCount: 1 }))).toBe(false);
  });

  it("refuses emptying a text post's caption with its own sentence", () => {
    expect(emptyCaptionMessage(job("t", { media: null, mediaCount: 0 }))).toBe("A post without a photo needs text.");
    expect(emptyCaptionMessage(job("f"))).toBe("Caption can't be empty.");
  });
});
