import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "reviews-view.tsx"), "utf8");
const at = (needle: string) => {
  const index = source.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

// N2: people open Reviews to answer reviews, so the list comes first.
describe("ReviewsView layout", () => {
  it("orders heading, picker, tabs, list, then the Get more reviews panel", () => {
    const heading = at("<h1");
    const picker = at("<LocationPicker");
    const tabs = at('aria-label="Review filter"');
    const list = at("needsReplyReviews.map((review) => renderReviewCard(");
    const panel = at("<ReviewLinkPanel");
    expect(heading).toBeLessThan(picker);
    expect(picker).toBeLessThan(tabs);
    expect(tabs).toBeLessThan(list);
    expect(list).toBeLessThan(panel);
  });

  it("shows the picker only through the 2+ locations helper", () => {
    expect(source).toContain("showLocationPicker(locations) && (");
    expect(source).toContain("singleLocationName(locations)");
  });

  it("drops the separate count box; the subtitle carries it", () => {
    expect(source).not.toContain("Reviews needing reply");
    expect(source).toContain("reviewsSubtitle(");
  });

  it("has an empty Needs reply state that points to the panel below", () => {
    expect(source).toContain("needsReplyEmptyTitle(reviews.length)");
    expect(source).toContain("Get more reviews below");
    expect(source).not.toContain("All caught up!");
  });

  it("moves focus on after a reply, with the toast as the only announcement", () => {
    expect(source).toContain("focusAfterReply(");
    expect(source).not.toContain('"Reply posted"');
  });
});

// R12 L1: the view words its states for who reads it (the page's isMember, from the server).
describe("ReviewsView and a member", () => {
  it("hands the role to the empty state and to both error cards", () => {
    expect(source).toMatch(/export function ReviewsView\(\{\s*savedLocation,\s*isMember,\s*workspaceId,\s*\}/);
    expect(source).toContain("<ReviewsEmptyState");
    expect(source).toContain("isMember={isMember}");
    expect(source.split("<ErrorState").length - 1).toBe(2);
    expect(source.match(/<ErrorState[^>]*isMember=\{isMember\}/g)?.length).toBe(2);
    expect(source).not.toContain("Go to connections");
    expect(source).not.toContain("SETTINGS_CONNECTIONS_HREF");
  });
});

// R17-client-journey addendum L1: one length rule, shared with the route.
describe("ReviewsView and Google's length limit", () => {
  it("refuses an over-long reply before the confirm dialog and before posting", () => {
    expect(source).toContain('from "@/lib/reviewReplyLength"');
    const request = source.slice(at("const requestReply"), at("const performReply"));
    expect(request).toContain("replyTooLong(comment)");
    expect(request).toContain("toast.error(REPLY_TOO_LONG_MESSAGE)");
    const perform = source.slice(at("const performReply"), at("const handleDraftAI"));
    expect(perform).toContain("replyTooLong(comment)");
  });
});

// Lead follow-up to R23 client-journey L3: the page keeps the replaced text
// through the reply-box helpers, and the card offers Undo.
describe("ReviewsView and the AI draft's Undo", () => {
  it("fills, types, undoes and clears through the helpers", () => {
    expect(source).toContain("replyBoxAfterDraft(");
    expect(source).toContain("replyBoxAfterTyping(");
    expect(source).toContain("replyBoxAfterUndo(");
    expect(source).toContain("replyBoxAfterPost(");
    expect(source).toMatch(/onUndoDraft=\{\s*replyBoxes\.undo\[review\.reviewId\] !== undefined/);
  });
});

// Lead review follow-up: one locked box per running draft.
describe("ReviewsView and several drafts at once", () => {
  it("tracks the reviews being drafted as a set", () => {
    expect(source).toContain("useState<ReadonlySet<string>>(new Set())");
    expect(source).toContain("draftingAfterStart(");
    expect(source).toContain("draftingAfterEnd(");
    expect(source).toContain("isGeneratingAI={generatingAI.has(review.reviewId)}");
    expect(source).not.toContain("setGeneratingAI(null)");
  });
});

// JJ3 lead review: a card draft that lands while focus is on that card's own
// Draft button gives focus to the new box; the decision is focusBoxAfterCardDraft.
describe("ReviewsView when a card draft lands", () => {
  it("notes where focus was as the draft lands, then decides with the shared rule once the box is open", () => {
    expect(source).toContain("activeId: document.activeElement?.id");
    expect(source).toMatch(/focusBoxAfterCardDraft\(\s*boxFocusAfterDraft\.activeId,\s*boxFocusAfterDraft\.reviewId,\s*replyingTo/);
    expect(source).toContain('document.getElementById("review-reply")?.focus()');
  });
});

// JJ3 lead review: a reply failing with the sign-in-again kind shows the link in that form.
describe("ReviewsView when a reply needs the owner to sign in again", () => {
  it("notes it on failure, clears it on typing, sending again and closing, and hands the form the link", () => {
    expect(source).toContain("replySignInAfterFailure(prev, review.reviewId, shown, isMember)");
    expect(source.split("replySignInCleared(prev, review.reviewId)").length - 1).toBeGreaterThanOrEqual(3);
    expect(source).toContain("replySignInUrl={replySignInHref(replySignIn, review.reviewId, workspaceId)}");
    expect(source).toContain("toast.error(shown.message)");
  });
});

// Lead review (R23): the open box is judged when the draft lands, not when it was asked for.
describe("ReviewsView when a draft lands while another review is open", () => {
  it("picks the open box from the current state through openAfterDraft", () => {
    expect(source).toContain("setReplyingTo((open) => openAfterDraft(open, review.reviewId))");
    expect(source).not.toContain("if (replyingTo !== review.reviewId)");
  });
});
