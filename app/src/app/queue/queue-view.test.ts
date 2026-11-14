import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  cancelRequest,
  coverEditNote,
  coverLabel,
  emptyCaptionMessage,
  isTextPost,
  PairChoice,
  pairLabel,
  readQueueView,
  saveQueueView,
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

  // R2-client-journey M1: both halves of a Feed and Story post in one request.
  it("asks the single cancel to include the other half of a Feed and Story post", () => {
    expect(cancelRequest(job("f", { alsoAsStory: true }), "one", true)).toEqual({
      url: "/api/posts/f/cancel",
      series: false,
      body: { includePair: true },
    });
    expect(cancelRequest(job("f", { alsoAsStory: true }), "one", false)).toEqual({
      url: "/api/posts/f/cancel",
      series: false,
    });
    // The rest of a series goes through cancel-series, which never takes the option.
    expect(cancelRequest(job("a", { seriesId: "s1" }), "rest", true)).toEqual({
      url: "/api/posts/a/cancel-series",
      series: true,
    });
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

// N3: the Queue remembers List or Calendar per browser.
describe("readQueueView / saveQueueView", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      data,
    };
  }

  it("reads back a saved view", () => {
    const storage = memoryStorage();
    saveQueueView(() => storage, "calendar");
    expect(readQueueView(() => storage)).toBe("calendar");
    saveQueueView(() => storage, "list");
    expect(readQueueView(() => storage)).toBe("list");
  });

  it("falls back to List for nothing saved, junk, or storage that throws", () => {
    expect(readQueueView(() => memoryStorage())).toBe("list");
    expect(readQueueView(() => memoryStorage({ "vibe.queueView": "grid" }))).toBe("list");
    expect(
      readQueueView(() => {
        throw new Error("SecurityError");
      }),
    ).toBe("list");
    expect(
      readQueueView(() => ({
        getItem: () => {
          throw new Error("blocked");
        },
      })),
    ).toBe("list");
  });

  it("never throws when saving fails", () => {
    expect(() =>
      saveQueueView(
        () => ({
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        }),
        "calendar",
      ),
    ).not.toThrow();
    expect(() =>
      saveQueueView(() => {
        throw new Error("SecurityError");
      }, "calendar"),
    ).not.toThrow();
  });
});

// F6: each half of a Feed and Story post says it belongs to the other.
describe("pairLabel", () => {
  it("says a Story belongs to the post at its time, and a feed post that it also goes as a Story", () => {
    const at = "2026-11-20T15:00:00.000Z";
    const formatted = new Date(at).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(pairLabel(job("s", { storyOf: { scheduledFor: at } }))).toBe(`Story of the post on ${formatted}`);
    expect(pairLabel(job("s", { storyOf: { scheduledFor: null } }))).toBe("Story of a post with no time set");
    expect(pairLabel(job("f", { alsoAsStory: true }))).toBe("Also as a Story");
  });

  it("says nothing for a post that is not part of a pair", () => {
    expect(pairLabel(job("a"))).toBeNull();
  });
});

// R2-client-journey M1: the dialog's line and checkbox for the other half.
describe("PairChoice", () => {
  const option = { line: "This post also goes out as a Story, set for Fri.", label: "Also cancel the Story", keptLine: "The Story is kept and keeps its time." };
  const render = (props: Partial<Parameters<typeof PairChoice>[0]>) =>
    renderToStaticMarkup(
      createElement(PairChoice, { option, loading: false, checked: true, onChange: () => {}, ...props }),
    );

  it("names the other half and offers it, checked", () => {
    const html = render({});
    expect(html).toContain("This post also goes out as a Story, set for Fri.");
    expect(html).toContain("Also cancel the Story");
    expect(html).toMatch(/type="checkbox" checked=""/);
    expect(html).not.toContain("is kept");
  });

  it("unchecked: says the other half is kept", () => {
    expect(render({ checked: false })).toContain("The Story is kept and keeps its time.");
  });

  it("while it is looked up, says so; with no other half, renders nothing", () => {
    expect(render({ loading: true })).toContain("Looking up the other half of this post");
    expect(render({ option: null })).toBe("");
  });

  it("a failed lookup: says only this post is changed, no checkbox", () => {
    const html = render({ option: null, failedLine: "Couldn't check whether this post has a Story half. Only this post will be cancelled." });
    expect(html).toContain("Couldn&#x27;t check whether this post has a Story half. Only this post will be cancelled.");
    expect(html).not.toContain("checkbox");
  });

  it("an other half that cannot be included: the line only, no checkbox", () => {
    const html = render({ option: { line: "It has already started publishing.", label: null, keptLine: null } });
    expect(html).toContain("It has already started publishing.");
    expect(html).not.toContain("checkbox");
  });
});
