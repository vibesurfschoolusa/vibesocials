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

// R23 pages L2 and L3: the action row wraps on a 375 px screen, and screen
// readers announce the stars.
describe("ReviewCard: small screens and screen readers", () => {
  it("the Reply and Draft buttons sit in a row that wraps", () => {
    const html = card("Maria Lopez");
    const row = html.match(/<div class="([^"]*)"><button[^>]*id="[^"]*"[^>]*>(?:(?!<\/button>).)*Reply to review/);
    expect(row, "action row").not.toBeNull();
    expect(row![1].split(" ")).toEqual(expect.arrayContaining(["flex", "flex-wrap", "gap-3"]));
  });

  // R24 pages L1: the header row wraps, so the "Needs reply" pill and the date
  // never break over two lines at 375 px.
  it("the header row wraps and the Needs reply pill stays on one line", () => {
    const html = card("Maria Lopez");
    const header = html.match(/<div class="([^"]*)"><div class="min-w-0"><div class="[^"]*font-semibold/);
    expect(header, "header row").not.toBeNull();
    expect(header![1].split(" ")).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "items-start", "justify-between", "gap-2"]),
    );
    const pill = html.match(/<span class="([^"]*)"[^>]*>Needs reply<\/span>/);
    expect(pill, "Needs reply pill").not.toBeNull();
    expect(pill![1].split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
  });

  // JJ3 second review: a one-word long name wraps inside the card at 375 px.
  it("the name column can shrink and a long one-word name wraps", () => {
    const html = card("Bartholomewsurfschoolfanatic");
    const column = html.match(/<div class="([^"]*)"><div class="([^"]*)">Bartholomewsurfschoolfanatic</);
    expect(column, "name column").not.toBeNull();
    expect(column![1].split(" ")).toContain("min-w-0");
    expect(column![2].split(" ")).toContain("break-words");
  });

  it("the card's Draft button stays focusable while it writes", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewCard, {
        review: {
          name: "accounts/1/locations/2/reviews/r1",
          reviewId: "r1",
          reviewer: { displayName: "Maria", isAnonymous: false },
          starRating: "FIVE",
          createTime: "2026-11-01T00:00:00Z",
          updateTime: "2026-11-01T00:00:00Z",
        },
        needsReply: true,
        isReplyOpen: false,
        isSubmitting: false,
        isGeneratingAI: true,
        replyValue: "",
        onOpenReply: () => {},
        onCloseReply: () => {},
        onChangeReply: () => {},
        onSubmitReply: () => {},
        onDraftAI: () => {},
      }),
    );
    const tag = html.match(/<button[^>]*aria-busy="true"[^>]*>/);
    expect(tag, "busy Draft button").not.toBeNull();
    expect(tag![0]).toContain('aria-disabled="true"');
    // JJ3 lead review: its id lets the page see focus was on it as the draft lands.
    expect(tag![0]).toContain('id="review-draft-r1"');
    expect(tag![0]).not.toMatch(/\sdisabled=""/);
  });

  it("the date stays on one line", () => {
    const html = card("Maria Lopez");
    expect(html).toMatch(/<span class="[^"]*\bwhitespace-nowrap\b[^"]*">[A-Z][a-z]{2} \d{1,2}, 20\d{2}<\/span>/);
  });

  it("the star rating is an image with its rating as the name", () => {
    expect(card("Maria Lopez")).toMatch(/<div[^>]*role="img"[^>]*aria-label="5 out of 5 stars"|<div[^>]*aria-label="5 out of 5 stars"[^>]*role="img"/);
  });
});

describe("ReviewCard: Undo after an AI draft", () => {
  function open(onUndoDraft?: () => void): string {
    const noop = () => {};
    return renderToStaticMarkup(
      createElement(ReviewCard, {
        review: {
          name: "accounts/1/locations/2/reviews/r1",
          reviewId: "r1",
          reviewer: { displayName: "Maria", isAnonymous: false },
          starRating: "FIVE",
          createTime: "2026-11-01T00:00:00Z",
          updateTime: "2026-11-01T00:00:00Z",
        },
        needsReply: true,
        isReplyOpen: true,
        isSubmitting: false,
        isGeneratingAI: false,
        replyValue: "Draft",
        onOpenReply: noop,
        onCloseReply: noop,
        onChangeReply: noop,
        onSubmitReply: noop,
        onDraftAI: noop,
        onUndoDraft,
      }),
    );
  }

  it("passes Undo to the open reply box", () => {
    expect(open(() => {})).toMatch(/>Undo<\/button>/);
    expect(open()).not.toMatch(/>Undo</);
  });
});
