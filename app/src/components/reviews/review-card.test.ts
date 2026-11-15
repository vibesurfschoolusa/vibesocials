import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewCard } from "./review-card";
import type { GoogleReview } from "./types";

// R19 client-journey: an anonymous reviewer reaches the card as "A Google user"
// (server/googleReviews.ts), so the card shows that name and its initial.
function card(displayName: string): string {
  const review: GoogleReview = {
    name: "accounts/1/locations/2/reviews/r1",
    reviewId: "r1",
    reviewer: { displayName, isAnonymous: displayName === "A Google user" },
    starRating: "FIVE",
    createTime: "2026-11-01T00:00:00Z",
    updateTime: "2026-11-01T00:00:00Z",
  };
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(ReviewCard, {
      review,
      needsReply: true,
      isReplyOpen: false,
      isSubmitting: false,
      isGeneratingAI: false,
      replyValue: "",
      onOpenReply: noop,
      onCloseReply: noop,
      onChangeReply: noop,
      onSubmitReply: noop,
      onDraftAI: noop,
    }),
  );
}

describe("ReviewCard: the reviewer", () => {
  it("an anonymous reviewer shows 'A Google user' and its initial", () => {
    const html = card("A Google user");
    expect(html).toContain(">A Google user<");
    expect(html).toMatch(/>A<\/div>/);
  });

  it("a real name is unchanged", () => {
    const html = card("Maria Lopez");
    expect(html).toContain(">Maria Lopez<");
    expect(html).toMatch(/>M<\/div>/);
  });

  // R21 client-journey L3: a name starting with an emoji keeps the whole emoji, not half a surrogate pair.
  it("a name starting with an emoji shows the whole emoji as its initial", () => {
    const html = card("\u{1F30A} Kai");
    expect(html).toContain(">\u{1F30A}</div>");
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
