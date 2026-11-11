import { describe, expect, it } from "vitest";

import {
  choosePlacement,
  FEED_CHOICE,
  parsePlacementMetadata,
  placementNote,
  reconcilePlacement,
  STORY_VIDEO_LIMIT_SEC,
  storyMediaRefusal,
  storyVideoLengthRefusal,
} from "./storyPlacement";

describe("parsePlacementMetadata", () => {
  it("reads feed and story", () => {
    expect(parsePlacementMetadata({ placement: "feed" }, "instagramMetadata")).toEqual({
      ok: true,
      value: { placement: "feed" },
    });
    expect(parsePlacementMetadata({ placement: "story" }, "facebookMetadata")).toEqual({
      ok: true,
      value: { placement: "story" },
    });
  });

  it("treats an absent field as no choice (feed)", () => {
    expect(parsePlacementMetadata(undefined, "instagramMetadata")).toEqual({ ok: true, value: undefined });
    expect(parsePlacementMetadata(null, "instagramMetadata")).toEqual({ ok: true, value: undefined });
  });

  it("refuses anything else and names the field", () => {
    const junk: unknown[] = [
      "story",
      [],
      {},
      { placement: "reel" },
      { placement: "story", caption: "x" },
      { placement: 1 },
    ];
    for (const value of junk) {
      const parsed = parsePlacementMetadata(value, "facebookMetadata");
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("facebookMetadata");
    }
  });
});

describe("storyMediaRefusal", () => {
  it("allows one file", () => {
    expect(storyMediaRefusal("instagram", 1)).toBeNull();
  });

  it("refuses several photos with the sentence", () => {
    expect(storyMediaRefusal("instagram", 3)).toBe(
      "A Story takes one photo or video. Choose Feed for Instagram, or remove the extra photos.",
    );
    expect(storyMediaRefusal("facebook_page", 2)).toBe(
      "A Story takes one photo or video. Choose Feed for Facebook Page, or remove the extra photos.",
    );
  });
});

describe("storyVideoLengthRefusal", () => {
  it("takes the limits from the platform pages", () => {
    expect(STORY_VIDEO_LIMIT_SEC).toEqual({ instagram: 60, facebook_page: 90 });
  });

  it("refuses a known length over the limit", () => {
    expect(storyVideoLengthRefusal("instagram", 75)).toBe(
      "Instagram Stories take videos up to 60 seconds. This one is 75 seconds.",
    );
    expect(storyVideoLengthRefusal("facebook_page", 90.2)).toBe(
      "Facebook Page Stories take videos up to 90 seconds. This one is 91 seconds.",
    );
  });

  it("allows a length at or under the limit", () => {
    expect(storyVideoLengthRefusal("instagram", 60)).toBeNull();
    expect(storyVideoLengthRefusal("facebook_page", 12)).toBeNull();
  });

  it("allows an unknown length (the server cannot know it)", () => {
    expect(storyVideoLengthRefusal("instagram", null)).toBeNull();
    // A browser reports Infinity or NaN when it cannot tell.
    expect(storyVideoLengthRefusal("instagram", Infinity)).toBeNull();
    expect(storyVideoLengthRefusal("instagram", NaN)).toBeNull();
  });
});

describe("the Create page's choice", () => {
  it("starts on Feed", () => {
    expect(FEED_CHOICE).toEqual({ placement: "feed", returnedToFeed: false });
  });

  it("chooses Story with one file", () => {
    expect(choosePlacement(FEED_CHOICE, "story", 1)).toEqual({ placement: "story", returnedToFeed: false });
  });

  it("does not choose Story with two or more photos", () => {
    expect(choosePlacement(FEED_CHOICE, "story", 2)).toBe(FEED_CHOICE);
  });

  it("returns a Story to Feed when a second photo is attached, and says so", () => {
    const story = choosePlacement(FEED_CHOICE, "story", 1);
    const back = reconcilePlacement(story, 2);
    expect(back).toEqual({ placement: "feed", returnedToFeed: true });
    expect(placementNote("instagram", back, 2)).toBe(
      "A Story takes one photo or video, so this post goes to the Instagram feed.",
    );
    // Removing the photo again keeps Feed: the person chooses Story again.
    expect(reconcilePlacement(back, 1).placement).toBe("feed");
  });

  it("leaves a choice alone when nothing conflicts", () => {
    const story = choosePlacement(FEED_CHOICE, "story", 1);
    expect(reconcilePlacement(story, 1)).toBe(story);
    expect(reconcilePlacement(FEED_CHOICE, 4)).toBe(FEED_CHOICE);
  });

  it("explains a Story and the several-photos rule", () => {
    expect(placementNote("facebook_page", { placement: "story", returnedToFeed: false }, 1)).toBe(
      "Stories show for 24 hours and have no caption. Your caption is not used on Facebook Page.",
    );
    expect(placementNote("instagram", FEED_CHOICE, 2)).toBe("A Story takes one photo or video.");
    expect(placementNote("instagram", FEED_CHOICE, 1)).toBeNull();
  });

  it("drops the returned-to-Feed note once the person chooses again", () => {
    expect(choosePlacement({ placement: "feed", returnedToFeed: true }, "feed", 1)).toEqual(FEED_CHOICE);
  });
});
