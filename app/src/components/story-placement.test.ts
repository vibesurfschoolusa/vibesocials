import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FEED_CHOICE, type PlacementChoice, type StoryPlatform } from "@/lib/storyPlacement";

import { StoryPlacementSettings } from "./story-placement";

const render = (
  platform: StoryPlatform,
  choice: PlacementChoice,
  fileCount: number,
  videoDurationSec: number | null = null,
) =>
  renderToStaticMarkup(
    createElement(StoryPlacementSettings, {
      platform,
      choice,
      fileCount,
      videoDurationSec,
      onChange: () => {},
    }),
  );

/** The radio input for `value`, whatever order React renders its attributes in. */
const input = (html: string, value: string) =>
  html.match(/<input[^>]*>/g)?.find((tag) => tag.includes(`value="${value}"`)) ?? "";

const STORY: PlacementChoice = { placement: "story", returnedToFeed: false };

describe("StoryPlacementSettings", () => {
  it("offers Feed and Story with Feed preselected", () => {
    const html = render("instagram", FEED_CHOICE, 1);

    expect(html).toContain("Instagram");
    expect(input(html, "feed")).toContain('checked=""');
    expect(input(html, "story")).not.toBe("");
    expect(input(html, "story")).not.toContain('checked=""');
    expect(html).not.toContain("Stories show for 24 hours");
  });

  it("with Story chosen, says the caption is not used", () => {
    const html = render("facebook_page", STORY, 1);

    expect(input(html, "story")).toContain('checked=""');
    expect(html).toContain(
      "Stories show for 24 hours and have no caption. Your caption is not used on Facebook Page.",
    );
  });

  it("with two or more photos, Story cannot be chosen", () => {
    const html = render("instagram", FEED_CHOICE, 2);

    expect(input(html, "story")).toContain('disabled=""');
    expect(html).toContain("A Story takes one photo or video.");
  });

  it("says so when a Story went back to Feed", () => {
    expect(render("instagram", { placement: "feed", returnedToFeed: true }, 2)).toContain(
      "A Story takes one photo or video, so this post goes to the Instagram feed.",
    );
  });

  it("shows the over-length video refusal for a Story", () => {
    expect(render("instagram", STORY, 1, 75)).toContain(
      "Instagram Stories take videos up to 60 seconds. This one is 75 seconds.",
    );
    expect(render("instagram", FEED_CHOICE, 1, 75)).not.toContain("Stories take videos up to");
  });
});
