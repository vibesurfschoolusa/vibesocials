import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewCardDTO } from "@/server/reviewLink";

import { DECISION_MAYBE_SAVED_MESSAGE, REVIEW_MORE_SENTENCE, ReviewListMore, ReviewPostCard, changeNoteHint } from "./review-link-view";

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
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Looks good<\/button>/);
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

// R27 MM3 (pages L5): "Looks good" disables itself once approved and the
// change request's Send goes with its form, so focus fell to the page and the
// new state was not announced. The state line is a live region from the first
// render, and focus goes to it (lib/focusAfter).
describe("ReviewPostCard: the answer to a decision", () => {
  const statusRegion = /<div role="status"[^>]*>(.*?)<\/div>/;

  it("has an empty status region before any decision", () => {
    const match = render(post()).match(statusRegion);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("");
  });

  it("shows the state inside that region", () => {
    expect(render(post({ state: "approved" })).match(statusRegion)![1]).toContain("You approved this");
    expect(render(post({ state: "change_requested", note: "x" })).match(statusRegion)![1]).toContain("Change requested");
  });

  it("a saved decision hands focus to the state line", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/if \(outcome\.kind === "saved"\) \{\s+focusAfterPress\(pressed, \(\) => stateRef\.current\);\s+setAsking\(false\);/);
    expect(source).toMatch(/onClick=\{\(event\) => void decide\(\{ decision: "approve", version: post\.version \}, event\.currentTarget\)\}/);
    expect(source).toMatch(/void decide\(\{ decision: "change", note \}, sendRef\.current\);/);
    expect(source).toMatch(/<Button ref=\{sendRef\} type="submit"/);
    expect(source).toMatch(/<p\s+ref=\{stateRef\}/);
  });
});

// Lead follow-up (R27 MM3): the empty region took the card's 12 px gap. It
// stays in the accessibility tree but takes no room while empty.
describe("ReviewPostCard: the empty status region takes no space", () => {
  it("is visually hidden while empty, never display:none", () => {
    const html = render(post());
    expect(html).toMatch(/<div role="status" class="empty:sr-only"><\/div>/);
    expect(html).not.toMatch(/<div role="status"[^>]*(hidden|display:\s*none)/);
  });
});

// Lead follow-up (R27 MM3): with no answer the decision may have been saved.
describe("ReviewPostCard: a decision that got no answer", () => {
  it("says it may have been saved and to reload, never that it failed", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(DECISION_MAYBE_SAVED_MESSAGE).toBe(
      "The answer was lost, so your choice may have been saved. Reload the page to see.",
    );
    const decide = source.slice(source.indexOf("async function decide("), source.indexOf("return (", source.indexOf("async function decide(")));
    expect(decide).toMatch(/await fetchOrNoAnswer\(/);
    expect(decide).not.toMatch(/await fetch\(/);
    expect(decide).toMatch(/isNoAnswer\(error\) \? DECISION_MAYBE_SAVED_MESSAGE : /);
    expect(decide).not.toContain("Couldn't save that. Check your connection");
  });
});
