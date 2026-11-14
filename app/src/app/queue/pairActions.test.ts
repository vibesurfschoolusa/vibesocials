import { describe, expect, it, vi } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  cardRequest,
  changedJobIds,
  foldedPairLine,
  foldQueuePairs,
  pairAwareFetch,
  pairDialogLine,
  pairEditNote,
  pairNeedsReload,
  withPairNote,
  type QueueCard,
} from "./pairActions";

const AT = "2026-11-20T15:00:00.000Z";

function job(id: string, overrides: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id,
    status: "scheduled",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: AT,
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

/** A Feed and Story post as GET /api/posts lists it: the feed job and its Story job. */
function pair(feedOverrides: Partial<PostJobDTO> = {}, storyOverrides: Partial<PostJobDTO> = {}) {
  const feed = job("feed-1", {
    alsoAsStory: true,
    publish: {
      targetPlatforms: ["instagram", "facebook_page"],
      youtubePrivacy: null,
      tiktokPrivacy: null,
      googlePostType: null,
      googleButton: null,
    },
    ...feedOverrides,
  });
  const story = job("story-1", {
    storyOf: { id: "feed-1", scheduledFor: feedOverrides.scheduledFor ?? AT },
    storyPlatforms: ["instagram"],
    publish: {
      targetPlatforms: ["instagram"],
      youtubePrivacy: null,
      tiktokPrivacy: null,
      googlePostType: null,
      googleButton: null,
    },
    ...storyOverrides,
  });
  return { feed, story };
}

// R3-client-journey M1: a Feed and Story post is ONE Queue card, as the client
// review link already shows it (reviewLink.ts foldStoryPairs).
describe("foldQueuePairs", () => {
  it("folds a Story into its feed post's card, which asks for both halves", () => {
    const { feed, story } = pair();
    const cards = foldQueuePairs([feed, story, job("other")]);

    expect(cards.map((card) => card.id)).toEqual(["feed-1", "other"]);
    expect(cards[0].story?.id).toBe("story-1");
    expect(cards[0].includePair).toBe(true);
    expect(cards[1].story).toBeUndefined();
    expect(cards[1].includePair).toBeUndefined();
  });

  it("keeps the feed post's place in the list, wherever the Story sorted", () => {
    const { feed, story } = pair();
    expect(foldQueuePairs([story, job("a"), feed]).map((card) => card.id)).toEqual(["a", "feed-1"]);
  });

  it("folds a held pair and a draft pair the same way", () => {
    for (const fields of [
      { status: "draft", approvalState: "pending", scheduledFor: null },
      { status: "draft", approvalState: "none", scheduledFor: null },
    ] as const) {
      const { feed, story } = pair(fields, fields);
      expect(foldQueuePairs([feed, story]).map((card) => card.id)).toEqual(["feed-1"]);
    }
  });

  it("a lone half whose partner is cancelled or deleted (no pair marks) is a normal card", () => {
    const cards = foldQueuePairs([job("feed-1"), job("story-9")]);
    expect(cards.map((card) => card.id)).toEqual(["feed-1", "story-9"]);
    expect(cards.every((card) => card.includePair === undefined && card.story === undefined)).toBe(true);
  });

  it("a half whose partner is not in the list (moved on, or on a later page) still asks for both halves", () => {
    const { feed, story } = pair();
    expect(foldQueuePairs([feed])[0].includePair).toBe(true);
    expect(foldQueuePairs([story])[0].includePair).toBe(true);
  });

  it("halves that no longer agree (status, approval or time) stay two cards, each acting alone", () => {
    for (const storyOverrides of [
      { status: "draft" as const },
      { approvalState: "pending" as const },
      { scheduledFor: "2026-11-21T15:00:00.000Z" },
    ]) {
      const { feed, story } = pair({}, storyOverrides);
      const cards = foldQueuePairs([feed, story]);
      expect(cards.map((card) => card.id)).toEqual(["feed-1", "story-1"]);
      expect(cards.every((card) => card.includePair === undefined)).toBe(true);
    }
  });

  it("posts that are not a pair come back exactly as they were", () => {
    const plain = job("a");
    expect(foldQueuePairs([plain])).toEqual([plain]);
  });
});

describe("foldedPairLine", () => {
  it("labels the card Feed and Story with the platforms of each half", () => {
    const { feed, story } = pair();
    const [card] = foldQueuePairs([feed, story]);
    expect(foldedPairLine(card, ["Instagram", "Facebook Page"])).toBe(
      "Feed and Story: the post goes to Instagram and Facebook Page, the Story to Instagram.",
    );
  });

  it("says nothing for a card without a folded Story", () => {
    expect(foldedPairLine(job("a"), ["Instagram"])).toBeNull();
  });
});

describe("cardRequest", () => {
  it("a pair card's request asks for both halves", () => {
    const card: QueueCard = { ...job("feed-1"), includePair: true };
    expect(cardRequest(card, "POST", { decision: "approve" })).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve", includePair: true }),
    });
  });

  it("any other card's request is unchanged", () => {
    expect(cardRequest(job("a"), "DELETE")).toEqual({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});

describe("pairAwareFetch (the Edit dialog's two-step save)", () => {
  it("adds includePair to each request of a pair card and keeps the last answer's note", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const base = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pair: { id: "story-1", kind: "story", changed: true, note: "Its Story was scheduled too." } }),
      };
    });
    const wrapped = pairAwareFetch({ ...job("feed-1"), includePair: true }, base);

    const response = await wrapped.fetchFn("/api/posts/feed-1/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledFor: AT }),
    });
    await response.json();

    expect(calls).toEqual([{ url: "/api/posts/feed-1/publish", body: { scheduledFor: AT, includePair: true } }]);
    expect(wrapped.lastAnswer()).toEqual({ ok: true, pair: expect.objectContaining({ changed: true }) });
  });

  it("leaves another card's requests alone", async () => {
    const base = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const wrapped = pairAwareFetch(job("a"), base);
    const init = { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"baseCaption":"x"}' };

    await wrapped.fetchFn("/api/posts/a", init);

    expect(base).toHaveBeenCalledWith("/api/posts/a", init);
  });
});

describe("what an answer does to the cards", () => {
  const card: QueueCard = { ...job("feed-1"), includePair: true };
  const changed = { pair: { id: "story-1", kind: "story", changed: true, note: "Its Story was cancelled too." } };
  const leftAlone = {
    pair: { id: "story-1", kind: "story", changed: false, note: "Its Story was already published, so it was not cancelled." },
  };

  it("changes both halves' cards once the answer says the other half changed too", () => {
    expect(changedJobIds(card, changed)).toEqual(["feed-1", "story-1"]);
    expect(pairNeedsReload(card, changed)).toBe(false);
  });

  it("a half left alone: only this post changes, and the Queue is read again so that half shows as it is", () => {
    expect(changedJobIds(card, leftAlone)).toEqual(["feed-1"]);
    expect(pairNeedsReload(card, leftAlone)).toBe(true);
  });

  it("a pair card whose other half is gone: read again too", () => {
    expect(pairNeedsReload(card, { ok: true })).toBe(true);
  });

  it("a card that is not a pair never re-reads and changes only itself", () => {
    expect(changedJobIds(job("a"), { ok: true })).toEqual(["a"]);
    expect(pairNeedsReload(job("a"), { ok: true })).toBe(false);
  });

  it("the toast adds the answer's sentence about the other half", () => {
    expect(withPairNote("Scheduled post cancelled.", leftAlone)).toBe(
      "Scheduled post cancelled. Its Story was already published, so it was not cancelled.",
    );
    expect(withPairNote("Draft deleted.", { ok: true })).toBe("Draft deleted.");
    expect(withPairNote("Draft deleted.", { pair: { note: 42 } })).toBe("Draft deleted.");
  });
});

describe("the dialogs of a Feed and Story card", () => {
  const { feed, story } = pair();
  const [card] = foldQueuePairs([feed, story]);

  it("say the Story is part of what the action does", () => {
    expect(pairDialogLine(card, "cancel")).toBe("Its Story is cancelled too.");
    expect(pairDialogLine(card, "delete")).toBe("Its Story is deleted too.");
    expect(pairDialogLine(card, "publish")).toBe("Its Story goes out now too.");
    expect(pairDialogLine(card, "submit")).toBe("Its Story is sent for approval with it.");
    expect(pairEditNote(card)).toBe("Changes go to the post and its Story.");
  });

  it("say nothing for another card", () => {
    expect(pairDialogLine(job("a"), "cancel")).toBeNull();
    expect(pairEditNote(job("a"))).toBeNull();
  });
});
