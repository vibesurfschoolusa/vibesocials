import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewCardDTO } from "@/server/reviewLink";

import { REVIEW_MORE_SENTENCE, ReviewListMore, ReviewPostCard, changeNoteHint } from "./review-link-view";

type ReviewPostDTO = ReviewCardDTO;

function post(over: Partial<ReviewPostDTO> = {}): ReviewPostDTO {
  return {
    id: "p1",
    scheduledFor: "2026-11-20T15:00:00.000Z",
    platforms: ["Instagram", "Facebook Page"],
    caption: "Sunday session",
    platformCaptions: [],
    media: { url: "https://x.example/a.jpg", mimeType: "image/jpeg" },
    mediaCount: 1,
    state: "pending",
    note: null,
    version: "v1",
    ...over,
  } as ReviewPostDTO;
}

function render(p: ReviewPostDTO): string {
  return renderToStaticMarkup(
    createElement("ul", null, createElement(ReviewPostCard, { post: p, token: "t", onDecided: () => {}, onStale: () => {} })),
  );
}

describe("ReviewPostCard", () => {
  it("shows the preview, time, platforms and caption with two full-width buttons on a phone", () => {
    const html = render(post());
    expect(html).toContain('src="https://x.example/a.jpg"');
    expect(html).toContain("<time");
    expect(html).toContain("Instagram, Facebook Page");
    expect(html).toContain("Sunday session");
    expect(html).toMatch(/<button[^>]*w-full[^>]*>Looks good<\/button>/);
    expect(html).toMatch(/<button[^>]*w-full[^>]*>Ask for a change<\/button>/);
  });

  it("shows a video with controls", () => {
    expect(render(post({ media: { url: "https://x.example/a.mp4", mimeType: "video/mp4" } }))).toContain("<video");
  });

  it("shows the approved state clearly and disables approving again", () => {
    const html = render(post({ state: "approved" }));
    expect(html).toContain("You approved this");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Looks good<\/button>/);
  });

  it("shows a change request with the client's note and no buttons", () => {
    const html = render(post({ state: "change_requested", note: "Use the other photo" }));
    expect(html).toContain("Change requested");
    expect(html).toContain("Use the other photo");
    expect(html).not.toContain("Looks good");
  });

  // R5-pages L6: a change request takes the post out of the schedule.
  it("shows a post whose change was requested as not scheduled, not at its old time", () => {
    const html = render(post({ state: "change_requested", note: "Use the other photo" }));
    expect(html).toContain("Not scheduled: waiting for your changes");
    expect(html).not.toContain("<time");
    expect(html).not.toContain("No time set");
  });

  it("says when no time is set", () => {
    expect(render(post({ scheduledFor: null }))).toContain("No time set");
  });
});

// F6: a Feed and Story post is one card.
describe("ReviewPostCard - a Feed and Story pair", () => {
  it("shows the line naming the Story under the platforms", () => {
    const html = render(post({ alsoStory: "Also as a Story on Instagram" }));
    expect(html).toContain("Also as a Story on Instagram");
  });

  it("shows no such line on a post without a Story", () => {
    expect(render(post())).not.toContain("Also as a Story");
  });

  it("says a change holds back the post and its Story together", () => {
    expect(changeNoteHint(post({ alsoStory: "Also as a Story on Instagram" }))).toBe(
      "This post and its Story will not go out until they are scheduled again.",
    );
    expect(changeNoteHint(post())).toBe("This post will not go out until it is scheduled again.");
  });
});

// R7-client-journey L5: the server lists at most 100 cards and says whether
// there are more; the page then says so under the list.
describe("ReviewListMore", () => {
  it("says more appear when the server says there are more", () => {
    expect(REVIEW_MORE_SENTENCE).toBe("Showing the next 100 scheduled posts; more appear as these go out.");
    expect(renderToStaticMarkup(createElement(ReviewListMore, { more: true }))).toContain(REVIEW_MORE_SENTENCE);
  });

  it("says nothing otherwise", () => {
    expect(renderToStaticMarkup(createElement(ReviewListMore, { more: false }))).toBe("");
  });
});
