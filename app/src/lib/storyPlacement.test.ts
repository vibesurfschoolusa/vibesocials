import { describe, expect, it } from "vitest";

import { queueOverridesToSend } from "./platformOverrides";
import {
  choosePlacement,
  FEED_CHOICE,
  initialPlacements,
  STORY_NO_CAPTION,
  STORY_ONLY_CAPTION_NOTE,
  storyOnlyCaptionNote,
  STORY_VIDEO_MIN_SEC,
  storyPlatformsOf,
  storyPlatformLabel,
  storyListing,
  queueEditorPlatforms,
  storyChoiceSuffix,
  withStoryCaptions,
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

  it("refuses a known length under 3 seconds (both pages: 3 seconds minimum)", () => {
    expect(STORY_VIDEO_MIN_SEC).toBe(3);
    expect(storyVideoLengthRefusal("instagram", 2)).toBe(
      "Instagram Stories need a video of at least 3 seconds. This one is 2 seconds.",
    );
    // Rounded down to a tenth, so a video just under the minimum never reads as 3.
    expect(storyVideoLengthRefusal("facebook_page", 2.99)).toBe(
      "Facebook Page Stories need a video of at least 3 seconds. This one is 2.9 seconds.",
    );
    expect(storyVideoLengthRefusal("instagram", 3)).toBeNull();
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

describe("initialPlacements", () => {
  it("puts both platforms back on Feed, as a fresh object each time", () => {
    const start = initialPlacements();
    expect(start).toEqual({ instagram: FEED_CHOICE, facebook: FEED_CHOICE });
    expect(initialPlacements()).not.toBe(start);
  });
});

describe("storyPlatformsOf (the job's stored publishMetadata)", () => {
  it("lists the platforms that were sent as a Story", () => {
    expect(
      storyPlatformsOf({ instagram: { placement: "story" }, facebook: { placement: "story" }, targetPlatforms: ["x"] }),
    ).toEqual(["instagram", "facebook_page"]);
    expect(storyPlatformsOf({ facebook: { placement: "story" } })).toEqual(["facebook_page"]);
  });

  it("a job without the snapshot, or with feed or junk, has none", () => {
    for (const value of [null, undefined, "x", [], {}, { instagram: { placement: "feed" } }, { instagram: "story" }]) {
      expect(storyPlatformsOf(value)).toEqual([]);
    }
  });
});

describe("withStoryCaptions (the approval email)", () => {
  it("shows a Story platform as having no caption, replacing any override", () => {
    expect(STORY_NO_CAPTION).toBe("Story, no caption");
    expect(withStoryCaptions({ instagram: "IG text", x: "X text" }, ["instagram", "facebook_page"])).toEqual({
      instagram: "Story, no caption",
      facebook_page: "Story, no caption",
      x: "X text",
    });
  });

  it("changes nothing without a Story", () => {
    const captions = { x: "X text" };
    expect(withStoryCaptions(captions, [])).toBe(captions);
    expect(withStoryCaptions(null, [])).toBeNull();
    expect(withStoryCaptions(null, ["instagram"])).toEqual({ instagram: "Story, no caption" });
  });
});

describe("storyOnlyCaptionNote (the line under the caption box)", () => {
  it("shows while every selected platform is a Story", () => {
    expect(STORY_ONLY_CAPTION_NOTE).toBe("Stories show no caption. This text is kept with the post but not published.");
    expect(storyOnlyCaptionNote(["instagram"], ["instagram"])).toBe(STORY_ONLY_CAPTION_NOTE);
    expect(storyOnlyCaptionNote(["instagram", "facebook_page"], ["instagram", "facebook_page"])).toBe(
      STORY_ONLY_CAPTION_NOTE,
    );
  });

  it("does not show when a selected platform publishes the caption, or nothing is selected", () => {
    expect(storyOnlyCaptionNote(["instagram", "x"], ["instagram"])).toBeNull();
    expect(storyOnlyCaptionNote(["instagram", "facebook_page"], ["instagram"])).toBeNull();
    expect(storyOnlyCaptionNote([], [])).toBeNull();
  });
});

describe("storyPlatformLabel", () => {
  it("adds (Story) for a Story platform only", () => {
    expect(storyPlatformLabel("instagram", ["instagram"])).toBe("Instagram (Story)");
    expect(storyPlatformLabel("facebook_page", ["instagram"])).toBe("Facebook Page");
    expect(storyPlatformLabel("instagram", [])).toBe("Instagram");
  });
});

describe("storyListing (what the Queue and the review page say)", () => {
  it("feed on both: nothing changes", () => {
    const captions = { instagram: "IG text" };
    const listing = storyListing(["instagram", "facebook_page"], captions, []);
    expect(listing.platformLabels).toEqual(["Instagram", "Facebook Page"]);
    expect(listing.platformCaptions).toBe(captions);
    expect(listing.storyOnly).toBe(false);
    expect(listing.storyOnlyNote).toBeNull();
  });

  it("a Story beside a feed post: labelled, and its entry reads Story, no caption", () => {
    const listing = storyListing(["instagram", "facebook_page"], { x: "X text" }, ["instagram"]);
    expect(listing.platformLabels).toEqual(["Instagram (Story)", "Facebook Page"]);
    expect(listing.platformCaptions).toEqual({ x: "X text", instagram: "Story, no caption" });
    expect(listing.storyOnly).toBe(false);
    expect(listing.storyOnlyNote).toBeNull();
  });

  it("only Stories: the note is given", () => {
    const listing = storyListing(["instagram", "facebook_page"], null, ["instagram", "facebook_page"]);
    expect(listing.storyOnly).toBe(true);
    expect(listing.storyOnlyNote).toBe(STORY_ONLY_CAPTION_NOTE);
  });

  it("a job with no stored placement (or no targets) is listed as before", () => {
    expect(storyListing(["instagram"], null, []).platformLabels).toEqual(["Instagram"]);
    const none = storyListing([], null, ["instagram"]);
    expect(none.storyOnly).toBe(false);
    expect(none.platformLabels).toEqual([]);
  });
});

describe("queueEditorPlatforms (Queue edit dialog)", () => {
  const both = ["instagram", "facebook_page"] as const;

  it("shows no editor for a Story but keeps every platform for what is sent", () => {
    const sets = queueEditorPlatforms(both, ["instagram"]);
    expect(sets.shown).toEqual(["facebook_page"]);
    expect(sets.sent).toEqual(["instagram", "facebook_page"]);
  });

  it("an edit to the feed caption sends both captions, the Story one unchanged", () => {
    const saved = { instagram: "IG stored", facebook_page: "FB stored" };
    const sent = queueOverridesToSend({
      current: { ...saved, facebook_page: "FB edited" },
      saved,
      mainCaption: "Main",
      platforms: queueEditorPlatforms(both, ["instagram"]).sent,
      hasOwnCaption: true,
    });
    expect(sent).toEqual({ instagram: "IG stored", facebook_page: "FB edited" });
  });

  it("a save with no edit sends nothing for captions", () => {
    const saved = { instagram: "IG stored", facebook_page: "FB stored" };
    expect(
      queueOverridesToSend({
        current: saved,
        saved,
        mainCaption: "Main",
        platforms: queueEditorPlatforms(both, ["instagram"]).sent,
        hasOwnCaption: true,
      }),
    ).toBeUndefined();
  });
});

describe("storyChoiceSuffix (a post with no chosen platforms)", () => {
  it("names the Story choice, or nothing", () => {
    expect(storyChoiceSuffix([])).toBe("");
    expect(storyChoiceSuffix(["instagram"])).toBe(" (Instagram as a Story)");
    expect(storyChoiceSuffix(["instagram", "facebook_page"])).toBe(
      " (Instagram as a Story, Facebook Page as a Story)",
    );
  });
});
