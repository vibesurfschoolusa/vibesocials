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

// JJ3 lead review, R25 pages L4: a refused reply keeps its sentence, and for an
// owner asked to sign in again the link, in that form.
describe("ReviewsView when a reply is refused", () => {
  it("notes it on failure, clears it on typing, sending again and closing, and hands the form the sentence and link", () => {
    expect(source).toContain("setReplyRefusal(replyRefusalAfterFailure(review.reviewId, shown, isMember))");
    expect(source.split("replyRefusalCleared(prev, review.reviewId)").length - 1).toBeGreaterThanOrEqual(2);
    expect(source).toContain("replySignInUrl={replySignInHref(replyRefusal, review.reviewId, workspaceId)}");
    expect(source).toContain("replyRefusal={replyRefusalMessage(replyRefusal, review.reviewId)}");
    expect(source).toContain("toast.error(shown.message)");
  });
});

// Lead review: a form closes on Cancel, on a posted reply, or when Reply opens
// another review's form; each way goes through openReply, which drops a
// refusal whose form is no longer open.
describe("ReviewsView when a reply form closes", () => {
  it("changes the open form only through openReply, which keeps a refusal only for the open form", () => {
    expect(source).toMatch(/const openReply = \(next: string \| null\) => \{\s*setReplyingTo\(next\);\s*setReplyRefusal\(\(prev\) => replyRefusalWhileOpen\(prev, next\)\);/);
    // Only openReply and the draft landing (which opens only when none is open) set it.
    expect(source.split("setReplyingTo(").length - 1).toBe(2);
    expect(source).toContain("setReplyingTo((open) => openAfterDraft(open, review.reviewId))");
  });
});

// R25 pages L1: Reply hands focus to the box; Cancel to that review's Reply button.
describe("ReviewsView and focus when a reply form opens or closes", () => {
  it("asks for the box on Reply, and decides with focusBoxOnOpen once it is open", () => {
    expect(source).toMatch(/onOpenReply=\{\(\) => \{\s*openReply\(review\.reviewId\);\s*setBoxFocusOnOpen\(review\.reviewId\);/);
    expect(source).toMatch(/focusBoxOnOpen\(\s*boxFocusOnOpen,\s*replyingTo\s*\)/);
  });

  it("sends focus to that review's Reply button on Cancel", () => {
    const close = source.slice(at("onCloseReply={"), at("onChangeReply={"));
    expect(close).toContain("setPendingFocus({ reviewId: review.reviewId })");
  });

  it("a draft that opens the form asks for nothing on open", () => {
    const draft = source.slice(at("const handleDraftAI"), at("const needsReplyReviews"));
    expect(draft).not.toContain("setBoxFocusOnOpen(");
  });
});

// R25 pages L4 / platform-clients L1: accounts whose locations Google would not
// send are said in a status line above the list (the route's `notice`).
describe("ReviewsView and accounts Google would not list", () => {
  it("reads the route's notice only when it is a string", () => {
    expect(source).toContain('setLocationsNotice(typeof data.notice === "string" && data.notice ? data.notice : null)');
  });

  it("shows it in a status region above the tabs and the list", () => {
    const main = source.slice(at("{/* Location Selector */}"));
    const region = main.indexOf('<LocationsNotice key="locations-notice"');
    expect(region).toBeGreaterThan(main.indexOf("<LocationPicker"));
    expect(region).toBeLessThan(main.indexOf('aria-label="Review filter"'));
    expect(source).toMatch(/<p role="status"[^>]*empty:sr-only[^>]*>\s*\{notice\}/);
  });

  // Lead review: a live region that first appears already filled may not be
  // announced, so it is on the page from the loading view on, with the same
  // key under the same page element, and only its text changes.
  it("keeps the region from the first render, the loading view included", () => {
    const loading = source.slice(at("if (loadingLocations) {"), at("if (locationsError) {"));
    expect(loading).toContain('<LocationsNotice key="locations-notice" notice={locationsNotice} />');
    expect(source.split('<LocationsNotice key="locations-notice" notice={locationsNotice} />').length - 1).toBe(2);
  });

  it("does not also say there are no locations when the notice says some were not read", () => {
    expect(source).toContain("!selectedLocation && locations.length === 0 && locationsNotice ? null");
  });
});

// Lead review (R23): the open box is judged when the draft lands, not when it was asked for.
describe("ReviewsView when a draft lands while another review is open", () => {
  it("picks the open box from the current state through openAfterDraft", () => {
    expect(source).toContain("setReplyingTo((open) => openAfterDraft(open, review.reviewId))");
    expect(source).not.toContain("if (replyingTo !== review.reviewId)");
  });
});
