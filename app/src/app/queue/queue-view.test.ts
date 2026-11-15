import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  cancelRequest,
  coverEditNote,
  coverLabel,
  emptyCaptionMessage,
  isTextPost,
  labelName,
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
    expect(cancelRequest(job("a", { seriesId: "s1" }), "one")).toMatchObject({
      url: "/api/posts/a/cancel",
      series: false,
    });
    expect(cancelRequest(job("a", { seriesId: "s1" }), "rest")).toMatchObject({
      url: "/api/posts/a/cancel-series",
      series: true,
    });
    // A post without a series can only be cancelled on its own.
    expect(cancelRequest(job("b"), "rest")).toMatchObject({ url: "/api/posts/b/cancel", series: false });
  });

  // R3-client-journey M1: a Feed and Story card's cancel asks for both halves.
  it("a pair card's cancel asks for both halves; another card's does not", () => {
    expect(JSON.parse(cancelRequest({ ...job("f"), includePair: true }, "one").init.body)).toEqual({
      includePair: true,
    });
    expect(JSON.parse(cancelRequest(job("a"), "one").init.body)).toEqual({});
    expect(cancelRequest(job("a"), "one").init.method).toBe("POST");
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
    expect(pairLabel(job("s", { storyOf: { id: "f", scheduledFor: at } }))).toBe(`Story of the post on ${formatted}`);
    expect(pairLabel(job("s", { storyOf: { id: "f", scheduledFor: null } }))).toBe("Story of a post with no time set");
    expect(pairLabel(job("f", { alsoAsStory: true }))).toBe("Also as a Story");
  });

  it("says nothing for a post that is not part of a pair", () => {
    expect(pairLabel(job("a"))).toBeNull();
  });
});

// R3-client-journey M1: a Feed and Story post is one card; the dialogs that
// asked about the other half are gone, and the shared ConfirmDialog stays.
describe("the cancel and delete dialogs", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("use the shared ConfirmDialog, not a local copy", () => {
    expect(queueSource).not.toContain("QueueConfirmDialog");
  });

  it("no longer look the other half up or offer a checkbox for it", () => {
    expect(queueSource).not.toContain("PairChoice");
    expect(queueSource).not.toContain("lookUpPair");
  });
});

// R5-pages L12: a button's name carries the caption's start, not all of it.
describe("labelName, the caption in a Queue button's name", () => {
  it("keeps a short caption whole", () => {
    expect(labelName("Dawn patrol")).toBe("Dawn patrol");
  });

  it("cuts a long caption to about 40 characters with an ellipsis", () => {
    const caption = "Sunday session at the pier with the whole crew, bring your board and sunscreen";
    const name = labelName(caption);
    expect(name).toBe("Sunday session at the pier with the who…");
    expect(Array.from(name)).toHaveLength(40);
  });

  it("joins lines and spaces into one line, and never cuts an emoji", () => {
    expect(labelName("Waves\n\n  today")).toBe("Waves today");
    const name = labelName(`${"a".repeat(38)}🏄‍♀️ more words after`);
    expect(name).toBe(`${"a".repeat(38)}🏄‍♀️…`);
  });

  it("names a post without a caption", () => {
    expect(labelName(null)).toBe("Untitled post");
    expect(labelName("   ")).toBe("Untitled post");
  });

  it("is what every button's name uses", () => {
    const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
    const names = queueSource.match(/aria-label=\{`[^`]*`\}/g) ?? [];
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) expect(name).toContain("${name}");
  });
});

// R16-pages L4: each of the Queue card's three "by" lines wraps a long label
// (a full address on a phone) in ByName, never the bare name.
describe("Queue card by lines", () => {
  it("name the author through ByName", () => {
    const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
    expect(queueSource.match(/by \{job\.createdBy\.name\}/g) ?? []).toEqual([]);
    expect(queueSource.match(/ · by <ByName name=\{job\.createdBy\.name\} \/>/g) ?? []).toHaveLength(3);
  });
});
