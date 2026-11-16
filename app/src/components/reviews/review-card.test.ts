import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewCard } from "./review-card";
import type { GoogleReview } from "./types";

// R19 client-journey: an anonymous reviewer reaches the card as "A Google user"
// (server/googleReviews.ts), so the card shows that name and its initial.
function card(displayName: string, extra: Partial<GoogleReview> = {}): string {
  const review: GoogleReview = {
    name: "accounts/1/locations/2/reviews/r1",
    reviewId: "r1",
    reviewer: { displayName, isAnonymous: displayName === "A Google user" },
    starRating: "FIVE",
    createTime: "2026-11-01T00:00:00Z",
    updateTime: "2026-11-01T00:00:00Z",
    ...extra,
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

  // R21 client-journey L3 + GG2 review: a name starting with an emoji shows its first
  // letter, never half a surrogate pair (the same rule as the account button).
  it("a name starting with an emoji shows its first letter as its initial", () => {
    const html = card("\u{1F30A} Kai");
    expect(html).toContain(">K</div>");
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

// R22 client-journey L3: a translated review and a multi-paragraph reply keep
// their line breaks, and a long URL wraps inside the card at 375 px.
describe("ReviewCard: the review and reply text", () => {
  const html = card("Maria Lopez", {
    comment: "(Translated by Google) Great\n\n(Original)\nGenial",
    reviewReply: { comment: "Thanks!\n\nSee you soon", updateTime: "2026-11-02T00:00:00Z" },
  });

  it("the review keeps its line breaks and wraps long words", () => {
    expect(html).toMatch(/<p class="[^"]*\bwhitespace-pre-wrap\b[^"]*\bbreak-words\b[^"]*">\(Translated by Google\)/);
  });

  it("the reply keeps its line breaks and wraps long words", () => {
    expect(html).toMatch(/<p class="[^"]*\bwhitespace-pre-wrap\b[^"]*\bbreak-words\b[^"]*">Thanks!/);
  });

  it("the text column can shrink below its content's width", () => {
    expect(html).toContain('class="min-w-0 flex-1"');
  });
});
