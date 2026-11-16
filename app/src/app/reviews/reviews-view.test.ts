import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GBP_NO_LISTING_NOTICE,
  listingNotice,
  unreadAccountsNotice,
} from "@/app/api/connections/google_business_profile/gbpLocations";
import { canRetry, ReviewsApiError } from "@/components/reviews/api-error";
import { gbpSignInUrl } from "@/lib/gbpSignIn";
import {
  MEMBER_NO_LOCATION_NOTICE,
  MEMBER_SAVED_NOT_LISTED_NOTICE,
  savedCodeSharedNotice,
} from "@/server/googleReviews";
import { NoAnswerError } from "@/lib/requestNoAnswer";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("./review-link-panel", () => ({ ReviewLinkPanel: () => null }));

import {
  DRAFT_OFFLINE_MESSAGE,
  draftFailureMessage,
  LocationsNotice,
  locationsSignIn,
  REPLY_OFFLINE_MESSAGE,
  replyFailureShown,
  ReviewsView,
} from "./reviews-view";

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

// R25 (KK1): a member's 403 for another location says its sentence with no Retry,
// and a refused reply that a retry can't change closes the confirm dialog.
describe("ReviewsView and an answer a retry can't change", () => {
  it("offers Retry on both error cards only through canRetry", () => {
    expect(source).toContain("onRetry={canRetry(error) ? onRetry : undefined}");
    expect(source).toContain("onRetry={canRetry(reviewsError) ? loadReviews : undefined}");
  });

  it("does not keep the confirm dialog open for a reply a retry can't change", () => {
    const perform = source.slice(at("const performReply"), at("const handleDraftAI"));
    expect(perform).toContain('if (canRetry(shown)) throw new ConfirmFailureShown("REPLY_FAILED");');
  });
});

// R25 lead review: one sign-in button per page; the reviews error card's wins.
describe("ReviewsView and one sign-in per page", () => {
  it("tells the panel when the reviews error card shows the sign-in", () => {
    expect(source).toContain("signInShownAbove={Boolean(locationsSignInUrl || (reviewsError && signInHref(reviewsError, workspaceId)))}");
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
    expect(source).toMatch(/<div role="status"[^>]*empty:sr-only[^>]*>\s*\{notice \? <p/);
  });

  // Lead review: a live region that first appears already filled may not be
  // announced, so it is on the page from the loading view on, with the same
  // key under the same page element, and only its text changes.
  it("keeps the region from the first render, the loading view included", () => {
    const loading = source.slice(at("if (loadingLocations) {"), at("if (locationsError) {"));
    expect(loading).toContain('<LocationsNotice key="locations-notice" notice={locationsNotice} signInUrl={locationsSignInUrl} />');
    expect(source.split('<LocationsNotice key="locations-notice" notice={locationsNotice} signInUrl={locationsSignInUrl} />').length - 1).toBe(2);
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

// KK3 after KK2: a reply whose request got no answer says so (not "Couldn't
// post your reply"), and a failure the page already toasted and put in the
// form's status line is thrown as ConfirmFailureShown, so the confirm dialog
// adds no second message. Final failures still close it (canRetry).
describe("ReviewsView when a reply fails", () => {
  it("no answer: the offline sentence, and the dialog stays open for a retry", () => {
    const shown = replyFailureShown(new NoAnswerError(new TypeError("Failed to fetch")));
    expect(shown.message).toBe(REPLY_OFFLINE_MESSAGE);
    expect(REPLY_OFFLINE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so your reply wasn't posted. Check your connection and try again.",
    );
    expect(canRetry(shown)).toBe(true);
  });

  it("try later: the route's sentence, and it stays open", () => {
    const shown = replyFailureShown(new ReviewsApiError("Google is busy. Try again in a minute.", false));
    expect(shown.message).toBe("Google is busy. Try again in a minute.");
    expect(canRetry(shown)).toBe(true);
  });

  it("reconnect, access or a review gone: final, so the dialog closes and the form keeps the sentence", () => {
    const shown = replyFailureShown(new ReviewsApiError("This review is no longer on Google. Reload the page.", false, false, false));
    expect(shown.message).toBe("This review is no longer on Google. Reload the page.");
    expect(canRetry(shown)).toBe(false);
  });

  it("anything else (a coding TypeError): the plain sentence, never the offline one", () => {
    const shown = replyFailureShown(new TypeError("Cannot read properties of undefined"));
    expect(shown.message).toBe("Couldn't post your reply. Try again in a minute.");
  });

  it("sends through fetchOrNoAnswer and never rethrows the raw error", () => {
    const perform = source.slice(at("const performReply"), at("const handleDraftAI"));
    expect(perform).toMatch(/await fetchOrNoAnswer\(`\/api\/reviews\/\$\{review\.reviewId\}\/reply`/);
    expect(perform).toContain("const shown = replyFailureShown(err);");
    expect(perform).not.toMatch(/throw err;/);
  });
});

// R26 client-journey L3: with zero locations the route sends the picker's
// notice (GBP_NO_LISTING_NOTICE) and, for an owner, signIn: true. The page shows
// that sentence with the sign-in, not "Add one in Google Business Profile".
describe("ReviewsView and an empty listing's notice", () => {
  const notice = "Google found no locations for this Google account.";

  it("offers the sign-in only for an owner, only with a notice, only on the flag", () => {
    // The whole answer, as the route sends it for an owner.
    const answer = { locations: [], connected: true, notice, signIn: true };
    expect(locationsSignIn(answer, false)).toBe(true);
    expect(locationsSignIn(answer, true)).toBe(false);
    expect(locationsSignIn({ notice, signIn: "yes" }, false)).toBe(false);
    expect(locationsSignIn({ notice }, false)).toBe(false);
    expect(locationsSignIn({ signIn: true }, false)).toBe(false);
    expect(locationsSignIn(null, false)).toBe(false);
  });

  it("shows the sentence and the sign-in for the page's own workspace in one status region", () => {
    const html = renderToStaticMarkup(
      createElement(LocationsNotice, { notice, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A" }),
    );
    expect(html).toMatch(
      /^<div role="status"[^>]*><p[^>]*>Google found no locations for this Google account\.<\/p><a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-A"[^>]*>Sign in to Google again /,
    );
    const plain = renderToStaticMarkup(createElement(LocationsNotice, { notice, signInUrl: null }));
    expect(plain).not.toContain("<a ");
    expect(renderToStaticMarkup(createElement(LocationsNotice, { notice: null, signInUrl: null }))).toMatch(
      /^<div role="status"[^>]*><\/div>$/,
    );
  });

  it("reads the flag from the answer and builds the link from the page's workspace", () => {
    expect(source).toContain("setLocationsSignInAsked(locationsSignIn(data, isMember));");
    expect(source).toContain("const locationsSignInUrl = locationsSignInAsked ? gbpSignInUrl(workspaceId) : null;");
    expect(source.split("<LocationsNotice key=\"locations-notice\" notice={locationsNotice} signInUrl={locationsSignInUrl} />").length - 1).toBe(2);
  });

  it("keeps Add one in Google Business Profile only for an answer with no notice", () => {
    expect(source).toContain("!selectedLocation && locations.length === 0 && locationsNotice ? null");
  });

  it("one sign-in per page: the panel adds none when the notice shows it", () => {
    expect(source).toContain(
      "signInShownAbove={Boolean(locationsSignInUrl || (reviewsError && signInHref(reviewsError, workspaceId)))}",
    );
  });
});

// R26 client-journey L5: "Draft AI response" with no connection said the AI failed.
describe("ReviewsView when a draft fails", () => {
  it("no answer: says no draft was written and to check the connection", () => {
    expect(DRAFT_OFFLINE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so no draft was written. Check your connection and try again.",
    );
    expect(draftFailureMessage(new NoAnswerError(new TypeError("Failed to fetch")))).toBe(DRAFT_OFFLINE_MESSAGE);
  });

  it("the route's sentence, else the AI sentence; never the offline one for other errors", () => {
    expect(draftFailureMessage(new ReviewsApiError("Too many drafts. Try again in a minute.", false))).toBe(
      "Too many drafts. Try again in a minute.",
    );
    expect(draftFailureMessage(new TypeError("Failed to fetch"))).toBe(
      "The AI could not write a reply. Try again, or write one yourself.",
    );
  });

  it("sends through fetchOrNoAnswer and shows draftFailureMessage", () => {
    const draft = source.slice(at("const handleDraftAI"), at("const needsReplyReviews"));
    expect(draft).toContain('await fetchOrNoAnswer("/api/reviews/draft-response", {');
    expect(draft).toContain("toast.error(draftFailureMessage(err));");
  });
});

// LL2 after LL1 (main 101feca): the page against the locations route's real
// answers, built from the route's own helpers and sentences.
describe("ReviewsView and the locations route's real empty answers", () => {
  const noUnread = { access: false, failed: false };
  const unescape = (html: string) => html.replace(/&#x27;/g, "'");

  it("owner, Google lists nothing: the sign-in notice and the link for the page's workspace", () => {
    const answer = { locations: [], connected: true, ...listingNotice({ locations: [], unread: noUnread }, "reviews") };
    expect(answer).toEqual({ locations: [], connected: true, notice: GBP_NO_LISTING_NOTICE, signIn: true });
    expect(locationsSignIn(answer, false)).toBe(true);
    const html = unescape(
      renderToStaticMarkup(createElement(LocationsNotice, { notice: GBP_NO_LISTING_NOTICE, signInUrl: gbpSignInUrl("ws-A") })),
    );
    expect(html).toContain(`<p class="text-sm text-muted-foreground">${GBP_NO_LISTING_NOTICE}</p>`);
    expect(html).toMatch(/<a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-A"/);
  });

  it("owner, accounts left unread: their notice, and no sign-in the route didn't ask for", () => {
    const answer = {
      locations: [],
      connected: true,
      ...listingNotice({ locations: [], unread: { access: true, failed: false } }, "reviews"),
    };
    expect(typeof answer.notice).toBe("string");
    expect(locationsSignIn(answer, false)).toBe(false);
  });

  it("member: each of the route's notices shows alone, with no sign-in", () => {
    const memberNotices = [
      MEMBER_NO_LOCATION_NOTICE,
      MEMBER_SAVED_NOT_LISTED_NOTICE,
      savedCodeSharedNotice("member"),
      unreadAccountsNotice({ access: true, failed: false }, "reviews", "member"),
    ];
    for (const text of memberNotices) {
      expect(typeof text).toBe("string");
      const answer = { locations: [], connected: true, notice: text };
      expect(locationsSignIn(answer, true)).toBe(false);
      // Even an owner's flag never gives a member the link.
      expect(locationsSignIn({ ...answer, signIn: true }, true)).toBe(false);
      const html = unescape(renderToStaticMarkup(createElement(LocationsNotice, { notice: text, signInUrl: null })));
      expect(html).toContain(text as string);
      expect(html).not.toContain("<a ");
    }
  });
});

// R27 client-journey L1: pick A then B, A answers last; A's reviews never show under B.
describe("ReviewsView loads only the selected location's reviews", () => {
  it("goes through loadReviewsFor with the latest-request guard", () => {
    const load = source.slice(at("const loadReviews = useCallback"), at("useEffect(() => {"));
    expect(source).toContain('from "@/components/reviews/load-reviews"');
    expect(source).toContain("useState(latestRequests)");
    expect(load).toContain("loadReviewsFor(selectedLocation, nextReviewsRequest(),");
    expect(load).not.toContain("fetch(");
    expect(load).not.toContain("finally");
  });
});

// R27 security-billing L1: reply and draft name the page's workspace; a refusal
// says so with Reload, and keeps what was typed.
describe("ReviewsView when the page was drawn for another workspace", () => {
  it("sends the page's workspaceId on reply and draft", () => {
    const perform = source.slice(at("const performReply"), at("const handleDraftAI"));
    expect(perform).toMatch(/body: JSON\.stringify\(\{\s*comment,\s*reviewName: review\.name,[^}]*workspaceId,\s*\}\)/);
    const draft = source.slice(at("const handleDraftAI"), at("const needsReplyReviews"));
    expect(draft).toMatch(/body: JSON\.stringify\(\{[^}]*workspaceId,\s*\}\)/);
  });

  it("a 409 WORKSPACE_CHANGED reply: the Reload sentence, final, so the dialog closes", () => {
    const shown = replyFailureShown(
      new ReviewsApiError("This page was opened for another workspace. Reload to see the one you're working in.", false, false, false, true),
    );
    expect(shown.reload).toBe(true);
    expect(canRetry(shown)).toBe(false);
  });

  it("shows the notice with Reload instead of the form's line, and keeps the typed reply", () => {
    const perform = source.slice(at("const performReply"), at("const handleDraftAI"));
    expect(perform).toMatch(/if \(shown\.reload\) setWorkspaceChanged\(true\);\s*else setReplyRefusal\(replyRefusalAfterFailure/);
    const failed = perform.slice(perform.indexOf("} catch"));
    expect(failed).not.toContain("setReplyBoxes");
    const draft = source.slice(at("const handleDraftAI"), at("const needsReplyReviews"));
    expect(draft).toContain("if (asksReload(err)) setWorkspaceChanged(true);");
    expect(draft.slice(draft.indexOf("} catch"))).not.toContain("setReplyBoxes");
  });

  it("draws the notice from the first render in both views, and focuses Reload once the dialog closes", () => {
    expect(source.split('<WorkspaceChangedNotice key="workspace-changed" shown={workspaceChanged} reloadRef={reloadRef} />').length - 1).toBe(2);
    expect(source).toMatch(/if \(!workspaceChanged \|\| confirmTarget\) return;\s*reloadRef\.current\?\.focus\(\);/);
  });

  it("renders the empty region on the first render", () => {
    const html = renderToStaticMarkup(createElement(ReviewsView, { savedLocation: null, isMember: false, workspaceId: "ws-1" }));
    expect(html).toContain('<div role="status" class="mb-6 flex flex-col items-start gap-3 empty:mb-0 empty:sr-only"></div><div role="status"');
  });
});

