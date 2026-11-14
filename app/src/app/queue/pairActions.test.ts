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
  takesOtherHalf,
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
        json: async () => ({ ok: true, otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was scheduled too." } }),
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
    expect(wrapped.lastAnswer()).toEqual({ ok: true, otherHalf: expect.objectContaining({ changed: true }) });
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
  const changed = { otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was cancelled too." } };
  const leftAlone = {
    otherHalf: { id: "story-1", kind: "story", changed: false, note: "Its Story was already published, so it was not cancelled." },
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
    expect(withPairNote("Draft deleted.", { otherHalf: { note: 42 } })).toBe("Draft deleted.");
  });
});

const WHEN = new Date(AT).toLocaleString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

describe("the dialogs of a Feed and Story card", () => {
  const { feed, story } = pair();
  const [card] = foldQueuePairs([feed, story]);

  it("name the Story, its platforms and its time as part of what the action does", () => {
    expect(pairDialogLine(card, "cancel")).toBe(`The Story on Instagram, set for ${WHEN}, is cancelled too.`);
    // A scheduled card offers Cancel, not Delete; a draft pair deletes both.
    const [draftCard] = foldQueuePairs(Object.values(pair({ status: "draft" }, { status: "draft" })));
    expect(pairDialogLine(draftCard, "delete")).toBe(`The Story on Instagram, set for ${WHEN}, is deleted too.`);
    expect(pairDialogLine(card, "publish")).toBe(`The Story on Instagram, set for ${WHEN}, goes out now too.`);
    expect(pairDialogLine(card, "submit")).toBe(
      `The Story on Instagram, set for ${WHEN}, is sent for approval with it.`,
    );
    expect(pairEditNote(card)).toBe(`Changes also go to the Story on Instagram, set for ${WHEN}.`);
    expect(takesOtherHalf(card, "cancel")).toBe(true);
  });

  it("say nothing for another card", () => {
    expect(pairDialogLine(job("a"), "cancel")).toBeNull();
    expect(pairEditNote(job("a"))).toBeNull();
    expect(takesOtherHalf(job("a"), "cancel")).toBe(false);
  });

  // Review of R3: the pair split across pages. The Story is on page 1, its feed
  // post on page 2, so the Story's card is its own; it still names the feed post.
  it("a Story card whose feed post is not loaded names the feed post and its time", () => {
    const lone = job("story-1", {
      storyOf: { id: "feed-1", scheduledFor: AT },
      pairHalf: { id: "feed-1", kind: "feed", status: "scheduled", scheduledFor: AT, platforms: ["instagram", "facebook_page"] },
    });
    const [only] = foldQueuePairs([lone]);

    expect(only.includePair).toBe(true);
    expect(pairDialogLine(only, "cancel")).toBe(
      `The feed post on Instagram and Facebook Page, set for ${WHEN}, is cancelled too.`,
    );
    expect(takesOtherHalf(only, "cancel")).toBe(true);
  });

  it("a feed post going to every connected platform, with no time: says so", () => {
    const lone = job("story-1", {
      storyOf: { id: "feed-1", scheduledFor: null },
      pairHalf: { id: "feed-1", kind: "feed", status: "draft", scheduledFor: null, platforms: null },
    });
    expect(pairDialogLine(foldQueuePairs([lone])[0], "delete")).toBe("The feed post, with no time set, is deleted too.");
  });

  it("a delete never promises to delete a scheduled other half", () => {
    const lone = job("feed-1", {
      status: "draft",
      alsoAsStory: true,
      pairHalf: { id: "story-1", kind: "story", status: "scheduled", scheduledFor: AT, platforms: ["instagram"] },
    });
    const [only] = foldQueuePairs([lone]);
    expect(pairDialogLine(only, "delete")).toBe(
      `The Story on Instagram, set for ${WHEN}, is scheduled, so it is not deleted. Cancel it on its own card first.`,
    );
    expect(takesOtherHalf(only, "delete")).toBe(false);
  });
});

describe("withPairNote and a partly sent pair", () => {
  it("shows the answer's own message when one half went out and the other did not", () => {
    expect(
      withPairNote("Publishing now — track it in Activity.", {
        message: "The Story is being sent. The feed post was not: Reconnect Facebook Page in Settings.",
        otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story is publishing too." },
      }),
    ).toBe("The Story is being sent. The feed post was not: Reconnect Facebook Page in Settings.");
  });
});
