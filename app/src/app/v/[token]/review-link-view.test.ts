import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewCardDTO } from "@/server/reviewLink";

import {
  REVIEW_ALREADY_APPROVED_MESSAGE,
  REVIEW_DECISION_MAYBE_SAVED_MESSAGE,
  REVIEW_POST_CHANGED_MESSAGE,
  REVIEW_POST_LOCKED_MESSAGE,
  reviewDecisionOutcome,
} from "@/lib/reviewLink";

import {
  REVIEW_CHANGE_ALREADY_SAVED_MESSAGE,
  REVIEW_MORE_SENTENCE,
  ReviewListMore,
  ReviewPostCard,
  REFRESH_FAILED_MESSAGE,
  alreadyStood,
  cardLineAfterReload,
  cardRefusalStart,
  cardsShown,
  dismissFocusTarget,
  goneLineTakesFocus,
  keepsCard,
  keptAfterReload,
  REVIEW_POST_GONE_MESSAGE,
  changeNoteHint,
  reviewCardName,
  shownCardLine,
  staleNotice,
} from "./review-link-view";

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
    createElement("ul", null, createElement(ReviewPostCard, { post: p, token: "t", onDecided: () => {}, onStale: async () => 1, reloads: 0 })),
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

  // R56 pages-b L2: up to 100 cards repeat these buttons, so each names its post.
  it("names the post on Looks good and Ask for a change, and keeps their text", () => {
    const html = render(post());
    const name = reviewCardName(post());
    expect(html).toContain(`aria-label="Looks good &quot;${name}&quot;"`);
    expect(html).toContain(`aria-label="Ask for a change &quot;${name}&quot;"`);
    expect(html).toMatch(/<button[^>]*aria-label="Looks good &quot;Sunday session, [^"]*&quot;"[^>]*>Looks good<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-label="Ask for a change &quot;Sunday session, [^"]*&quot;"[^>]*>Ask for a change<\/button>/);
    expect(render(post({ caption: "" }))).toContain(`aria-label="Looks good &quot;${reviewCardName(post({ caption: "" }))}&quot;"`);
    expect(reviewCardName(post({ caption: "" }))).toMatch(/^Untitled post, /);
  });

  it("names the post on Send, Cancel and Dismiss too (states that need a press first)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    for (const text of ["Send", "Cancel", "Dismiss"]) {
      expect(source).toContain("aria-label={`" + text + " \"${cardName}\"`}");
    }
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
  // R30 lead review: a card is one of many in a list, so the line has no region of its
  // own; a change of its text is read through the page's announcer.
  const statusRegion = /<div class="empty:sr-only">(.*?)<\/div>/;

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
    // Only a change is read out: the cards a reload brings are not each read.
    expect(source).toContain('useAnnounceOnShow(() => state ?? "", true, false);');
  });
});

// Lead follow-up (R27 MM3): the empty region took the card's 12 px gap. It
// stays in the accessibility tree but takes no room while empty.
describe("ReviewPostCard: the empty status region takes no space", () => {
  it("is visually hidden while empty, never display:none", () => {
    const html = render(post());
    expect(html).toMatch(/<div class="empty:sr-only"><\/div>/);
    expect(html).not.toContain('role="status"');
  });
});

// Lead follow-up (R27 MM3): with no answer the decision may have been saved.
describe("ReviewPostCard: a decision that got no answer", () => {
  it("says it may have been saved and to reload, never that it failed", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    // One sentence for both cases, from lib/reviewLink (its tests check the words).
    expect(REVIEW_DECISION_MAYBE_SAVED_MESSAGE).toMatch(/may have been saved/);
    expect(source).not.toMatch(/const DECISION_MAYBE_SAVED_MESSAGE/);
    const decide = source.slice(source.indexOf("async function decide("), source.indexOf("return (", source.indexOf("async function decide(")));
    expect(decide).toMatch(/await fetchOrNoAnswer\(/);
    expect(decide).not.toMatch(/await fetch\(/);
    expect(decide).toMatch(/isNoAnswer\(error\) \? REVIEW_DECISION_MAYBE_SAVED_MESSAGE : /);
    expect(decide).not.toContain("Couldn't save that. Check your connection");
  });
});

// R27 MM3 lead review (already on main): "Ask for a change" is replaced by the
// form, and the form's Cancel by the buttons again. Focus goes to the note box,
// and back to "Ask for a change".
describe("ReviewPostCard: focus in Ask for a change", () => {
  it("Ask for a change focuses the note box; Cancel returns to Ask for a change", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/focusAfterPress\(event\.currentTarget, \(\) => noteRef\.current\);\s+setAsking\(true\);/);
    expect(source).toMatch(/focusAfterPress\(event\.currentTarget, \(\) => askRef\.current\);\s+setAsking\(false\);/);
    expect(source).toMatch(/<Textarea\s+ref=\{noteRef\}/);
    expect(source).toMatch(/ref=\{askRef\}/);
  });
});

// R29 client-journey L2: Send again after a lost answer finds the request
// standing; the route answers `already`. The card shows it saved, and the list
// reloads with a notice, as for an approval that already stood.
describe("ReviewPostCard: a change request that already stood", () => {
  it("marks the card saved, then reloads the list with the notice", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE).toBe("Your change request was already saved. The list was loaded again.");
    expect(source).toMatch(
      /onDecided\(outcome\.patch\);\s+(\/\/[^\n]*\n\s+)*if \(alreadyStood\(data\)\) onStale\(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE\);\s+return;/,
    );
  });

  it("alreadyStood reads only the route's flag", () => {
    expect(alreadyStood({ ok: true, state: "change_requested", note: "x", already: true })).toBe(true);
    expect(alreadyStood({ ok: true, state: "change_requested", note: "x" })).toBe(false);
    expect(alreadyStood(null)).toBe(false);
  });
});

// R30 client-journey L3: "The list was loaded again" showed before the reload,
// even when it then failed. The notice is set only once load() has answered,
// and a failed reload words it without claiming the list was loaded again.
describe("ReviewLinkView: the notice after a reload", () => {
  it("keeps the reload claim only when the reload worked", () => {
    expect(staleNotice(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE, true)).toBe(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE);
    expect(staleNotice(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE, false)).toBe("Your change request was already saved.");
    expect(staleNotice(REVIEW_ALREADY_APPROVED_MESSAGE, true)).toBe(REVIEW_ALREADY_APPROVED_MESSAGE);
    expect(staleNotice(REVIEW_ALREADY_APPROVED_MESSAGE, false)).toBe("This post was already approved.");
    expect(staleNotice(REVIEW_POST_CHANGED_MESSAGE, true)).toBe(REVIEW_POST_CHANGED_MESSAGE);
    expect(staleNotice(REVIEW_POST_CHANGED_MESSAGE, false)).toBe("This post was changed after you opened this page.");
  });

  it("is set from load()'s answer, not before it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    const stale = source.slice(source.indexOf("const stale = useCallback("), source.indexOf("[load],", source.indexOf("const stale = useCallback(")));
    expect(stale).toMatch(/load\(\)\.then\(\(reloaded\) => \{\s*setNotice\(staleNotice\(message, reloaded !== null\)\);\s*return reloaded;\s*\}\)/);
    expect(stale).not.toMatch(/setNotice\(message\)/);
  });
});

// R31 client-journey L1 (lead review): on a "changed" 409 the card says at once
// what is true, its spinner stops, and the list reloads in the background (a
// stalled reload must not keep Looks good spinning). A reload that worked adds
// "Have a look at the new version"; one that failed leaves the reload step to
// the refresh alert alone, and the card's line goes when a later reload works.
describe("ReviewPostCard: a post changed since the page loaded", () => {
  const changed = { kind: "changed", message: REVIEW_POST_CHANGED_MESSAGE } as const;

  it("at once: the true sentence, and a reload to start", () => {
    const start = cardRefusalStart(changed, 2);
    expect(start.reload).toBe(true);
    expect(start.line).toEqual({ text: "This post was changed after you opened this page.", clearAfter: 2 });
    expect(shownCardLine(start.line, 2)).toBe("This post was changed after you opened this page.");
  });

  it("the reload worked: the card says to look at the new version, and keeps it", () => {
    const line = cardLineAfterReload(cardRefusalStart(changed, 0).line, REVIEW_POST_CHANGED_MESSAGE, 1);
    expect(shownCardLine(line, 1)).toBe(REVIEW_POST_CHANGED_MESSAGE);
    expect(shownCardLine(line, 5)).toBe(REVIEW_POST_CHANGED_MESSAGE);
  });

  it("the reload failed: the reload step is on screen once (the refresh alert's)", () => {
    const line = cardLineAfterReload(cardRefusalStart(changed, 0).line, REVIEW_POST_CHANGED_MESSAGE, null);
    const card = shownCardLine(line, 0) ?? "";
    expect(card).toBe("This post was changed after you opened this page.");
    const notice = staleNotice(REVIEW_POST_CHANGED_MESSAGE, false);
    expect(`${REFRESH_FAILED_MESSAGE} ${notice} ${card}`.match(/reload/gi)).toHaveLength(1);
    expect(`${notice} ${card}`).not.toContain("Have a look");
  });

  it("a later Reload the list that works clears the card's line", () => {
    const line = cardLineAfterReload(cardRefusalStart(changed, 3).line, REVIEW_POST_CHANGED_MESSAGE, null);
    expect(shownCardLine(line, 3)).not.toBeNull();
    expect(shownCardLine(line, 4)).toBeNull();
  });

  it("any other refusal is the route's sentence, with no reload, and stays", () => {
    const start = cardRefusalStart({ kind: "refused", message: "This link has been turned off." }, 0);
    expect(start.reload).toBe(false);
    expect(shownCardLine(start.line, 9)).toBe("This link has been turned off.");
  });

  it("decide shows the line at once and runs the reload in the background", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    const decide = source.slice(source.indexOf("async function decide("), source.indexOf("return (", source.indexOf("async function decide(")));
    expect(decide).toMatch(/const start = cardRefusalStart\(outcome, reloads\);\s*setError\(start\.line\);\s*if \(start\.reload\) \{\s*void onStale\(outcome\.message, keepsCard\(outcome\.message\) \? post : undefined\)\.then\(/);
    expect(decide).not.toMatch(/await onStale|await cardRefusal/);
    expect(source).toContain("shownCardLine(error, reloads)");
  });

  it("the view counts reloads that worked and hands the count to each card", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/setPosts\(data\.posts\);\s*setMore\(data\.more === true\);\s*const count = \+\+reloadCount\.current;\s*setReloads\(count\);\s*listShown\.current = true;\s*return count;/);
    expect(source).toContain("reloads={reloads}");
  });
});

// R32 client-journey L1: "can no longer be changed here" reloads the list like
// "changed": the card says it at once, the reload runs in the background, and
// the line follows the reload's result.
describe("ReviewPostCard: a post that can no longer be changed here", () => {
  const locked = reviewDecisionOutcome(409, { error: REVIEW_POST_LOCKED_MESSAGE }) as { kind: "changed"; message: string };

  it("at once: the short sentence, and a reload to start", () => {
    const start = cardRefusalStart(locked, 1);
    expect(start.reload).toBe(true);
    expect(start.line).toEqual({ text: REVIEW_POST_LOCKED_MESSAGE, clearAfter: 1 });
  });

  it("the reload worked: the card and the notice say what the list now shows", () => {
    const line = cardLineAfterReload(cardRefusalStart(locked, 0).line, locked.message, 1);
    expect(shownCardLine(line, 1)).toBe(
      "This post can no longer be changed here. The list below is up to date.",
    );
    expect(staleNotice(locked.message, true)).toBe(shownCardLine(line, 1));
  });

  // R33 client-journey L3: the post comes back on a later reload; the line goes with it.
  it("the reload worked: a later working reload clears the line", () => {
    const line = cardLineAfterReload(cardRefusalStart(locked, 2).line, locked.message, 4);
    expect(line).toEqual({ text: locked.message, clearAfter: 4 });
    expect(shownCardLine(line, 4)).toBe("This post can no longer be changed here. The list below is up to date.");
    expect(shownCardLine(line, 5)).toBeNull();
  });

  it("gone after its own reload, listed again on a later one: no locked line over working buttons", () => {
    const a = post({ id: "a" });
    const line = cardLineAfterReload(cardRefusalStart(locked, 0).line, locked.message, 1);
    // Reload 1 (its own) dropped it: kept and shown gone.
    let kept = keptAfterReload([a], []);
    expect(cardsShown([], kept)).toEqual([{ post: a, gone: true }]);
    // Reload 2 lists it again: let go, and its line is cleared.
    kept = keptAfterReload(kept, [a]);
    expect(cardsShown([a], kept)).toEqual([{ post: a, gone: false }]);
    expect(shownCardLine(line, 2)).toBeNull();
  });

  it("a changed post's line still stays after its reload", () => {
    const line = cardLineAfterReload(
      cardRefusalStart({ kind: "changed", message: REVIEW_POST_CHANGED_MESSAGE }, 0).line,
      REVIEW_POST_CHANGED_MESSAGE,
      1,
    );
    expect(shownCardLine(line, 9)).toBe(REVIEW_POST_CHANGED_MESSAGE);
  });

  it("the reload failed: no claim about the list, and the reload step only once (the refresh alert's)", () => {
    const line = cardLineAfterReload(cardRefusalStart(locked, 0).line, locked.message, null);
    const card = shownCardLine(line, 0) ?? "";
    expect(card).toBe(REVIEW_POST_LOCKED_MESSAGE);
    const notice = staleNotice(locked.message, false);
    expect(notice).toBe(REVIEW_POST_LOCKED_MESSAGE);
    expect(`${REFRESH_FAILED_MESSAGE} ${notice} ${card}`.match(/reload/gi)).toHaveLength(1);
  });
});

// R32 lead review: a card the person acted on that the reload no longer lists
// (published, cancelled or moved) stays, shown as gone, so its typed note,
// focus and line are not lost; Dismiss removes it.
describe("ReviewPostCard: kept after the reload when the post left the list", () => {
  const a = post({ id: "a", scheduledFor: "2026-11-20T10:00:00.000Z" });
  const b = post({ id: "b", scheduledFor: "2026-11-21T10:00:00.000Z" });
  const c = post({ id: "c", scheduledFor: "2026-11-22T10:00:00.000Z" });

  it("a kept card shows as gone only when the list no longer has it, in its time order", () => {
    expect(cardsShown([a, c], [b])).toEqual([
      { post: a, gone: false },
      { post: b, gone: true },
      { post: c, gone: false },
    ]);
    expect(cardsShown([a, b], [b])).toEqual([
      { post: a, gone: false },
      { post: b, gone: false },
    ]);
    expect(cardsShown([], [b])).toEqual([{ post: b, gone: true }]);
    expect(cardsShown([a], [post({ id: "n", scheduledFor: null })])).toEqual([
      { post: a, gone: false },
      { post: post({ id: "n", scheduledFor: null }), gone: true },
    ]);
  });

  it("a gone card says so, disables Looks good and Ask for a change, and offers Dismiss", () => {
    expect(REVIEW_POST_GONE_MESSAGE).toBe(
      "This post can no longer be changed here: it was published, cancelled or moved.",
    );
    const html = renderToStaticMarkup(
      createElement(
        "ul",
        null,
        createElement(ReviewPostCard, { post: a, token: "t", onDecided: () => {}, onStale: async () => 1, reloads: 0, gone: true, onDismiss: () => {} }),
      ),
    );
    expect(html).toContain(REVIEW_POST_GONE_MESSAGE);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Looks good<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ask for a change<\/button>/);
    expect(html).toContain(">Dismiss</button>");
    expect(render(a)).not.toContain("Dismiss");
  });

  it("the card keeps its note readable and copyable, disables Send, and takes focus to its line", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/readOnly=\{gone\}/);
    expect(source).toMatch(/disabled=\{gone \|\| limited \|\| noteTooShort \|\| noteTooLong\}/);
    expect(source).toMatch(/if \(focusLine\) lineRef\.current\?\.focus\(\);/);
    expect(source).toContain("const focusLine = goneLineTakesFocus(gone, ownReload, reloads);");
    // Only a refusal that reloads keeps its card; the view merges with cardsShown.
    expect(source).toContain("void onStale(outcome.message, keepsCard(outcome.message) ? post : undefined).then(");
    expect(source).toContain("cardsShown(posts, kept)");
    expect(source).toMatch(/setKept\(\(current\) => \[\.\.\.current\.filter\(\(p\) => p\.id !== keep\.id\), keep\]\)/);
  });
});

// R32 lead's second review: only a LOCKED refusal keeps a card, and a reload
// that lists the post again lets it go, so a card can't come back hours later
// and take focus. A gone card's note can't be closed away by Cancel, and
// Dismiss hands focus to the next card, or the page's heading.
describe("ReviewPostCard: which cards are kept, and for how long", () => {
  const a = post({ id: "a", scheduledFor: "2026-11-20T10:00:00.000Z" });
  const b = post({ id: "b", scheduledFor: "2026-11-21T10:00:00.000Z" });

  it("only the locked refusal keeps a card", () => {
    const locked = reviewDecisionOutcome(409, { error: REVIEW_POST_LOCKED_MESSAGE }) as { message: string };
    expect(keepsCard(locked.message)).toBe(true);
    expect(keepsCard(REVIEW_POST_CHANGED_MESSAGE)).toBe(false);
    expect(keepsCard(REVIEW_ALREADY_APPROVED_MESSAGE)).toBe(false);
  });

  it("changed, then approved, then a later reload for another card: A doesn't return", () => {
    let kept: ReviewPostDTO[] = [];
    // A changed: not kept; reload lists A (approved later, still listed).
    if (keepsCard(REVIEW_POST_CHANGED_MESSAGE)) kept = [...kept, a];
    kept = keptAfterReload(kept, [a, b]);
    // B locked: kept; the reload no longer has A (published) or B.
    kept = [...kept, b];
    kept = keptAfterReload(kept, []);
    expect(cardsShown([], kept).map((card) => card.post.id)).toEqual(["b"]);
  });

  it("a kept card is let go once a reload lists its post again", () => {
    let kept = keptAfterReload([a], []);
    expect(kept).toEqual([a]);
    kept = keptAfterReload(kept, [a, b]);
    expect(kept).toEqual([]);
    expect(cardsShown([b], kept).map((card) => card.post.id)).toEqual(["b"]);
  });

  // R33 pages L6b: only the reload this card's own press started moves focus to its line.
  it("a gone card's line takes focus only when its own press's reload dropped it", () => {
    // Its own reload (number 3) is the latest and dropped it.
    expect(goneLineTakesFocus(true, 3, 3)).toBe(true);
    // Its own reload failed (none recorded); another card's reload 4 drops it.
    expect(goneLineTakesFocus(true, null, 4)).toBe(false);
    // Its own reload 3 listed it; another card's reload 5 drops it later.
    expect(goneLineTakesFocus(true, 3, 5)).toBe(false);
    expect(goneLineTakesFocus(false, 3, 3)).toBe(false);
  });

  it("the card records its own reload's number when that reload worked", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/\.then\(\(reloaded\) => \{\s*if \(reloaded !== null\) setOwnReload\(reloaded\);/);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(focusLine\) lineRef\.current\?\.focus\(\);\s*\}, \[focusLine\]\);/);
  });

  it("Dismiss's focus goes to the next card, else the page's heading", () => {
    const next = { id: "next" } as unknown as HTMLElement;
    const heading = { id: "h1" } as unknown as HTMLElement;
    const doc = { querySelector: (selector: string) => (selector === "main h1" ? heading : null) };
    expect(dismissFocusTarget({ nextElementSibling: next } as unknown as Element, doc)).toBe(next);
    expect(dismissFocusTarget({ nextElementSibling: null } as unknown as Element, doc)).toBe(heading);
    expect(dismissFocusTarget(null, doc)).toBe(heading);
  });

  it("the view lets kept cards go on each reload; Cancel is off on a gone card; Dismiss uses focusAfterPress", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./review-link-view.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/setKept\(\(current\) => keptAfterReload\(current, listed\)\);\s*setPosts\(data\.posts\);/);
    const at = source.search(/>\s*Cancel\s*</);
    const cancel = source.slice(source.lastIndexOf("<Button", at), at);
    expect(cancel).toContain("disabled={gone || busy}");
    expect(source).toMatch(/const target = dismissFocusTarget\(pressed\.closest\("li"\), document\);\s*focusAfterPress\(pressed, \(\) => target\);\s*onDismiss\?\.\(\);/);
  });
});

// R57 client-journey L2: a Story-only post's caption is a fixed line, so its
// cards' buttons are named by the card's time instead.
describe("reviewCardName", () => {
  const at = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const storyOnly = (over: Partial<ReviewPostDTO> = {}) =>
    post({ platforms: ["Instagram (Story)", "Facebook Page (Story)"], caption: "This goes out as a Story, with no caption.", ...over });

  it("two Story-only cards at different times have different names, each short and naming the Story", () => {
    const a = render(storyOnly({ id: "a", scheduledFor: "2026-11-20T15:00:00.000Z" }));
    const b = render(storyOnly({ id: "b", scheduledFor: "2026-11-21T15:00:00.000Z" }));
    const nameOf = (html: string) => /aria-label="Looks good &quot;([^"]*)&quot;"[^>]*>Looks good<\/button>/.exec(html)?.[1];
    const [nameA, nameB] = [nameOf(a), nameOf(b)];
    expect(nameA).toBeDefined();
    expect(nameA).not.toBe(nameB);
    for (const name of [nameA, nameB]) {
      expect(name).toMatch(/^Story, /);
      expect(name).not.toContain("with no caption");
      expect((name as string).length).toBeLessThanOrEqual(60);
    }
    expect(reviewCardName(storyOnly({ scheduledFor: "2026-11-20T15:00:00.000Z" }))).toBe(`Story, ${at("2026-11-20T15:00:00.000Z")}`);
  });

  // R58 client-journey L1: a Repeat series gives every card one caption, so a
  // captioned card is named by its caption and its time (cardName).
  it("a captioned card is named by its caption and its time", () => {
    expect(reviewCardName(post())).toBe(`Sunday session, ${at("2026-11-20T15:00:00.000Z")}`);
    expect(reviewCardName(post({ platforms: ["Instagram (Story)", "Facebook Page"] }))).toBe(
      `Sunday session, ${at("2026-11-20T15:00:00.000Z")}`,
    );
    expect(reviewCardName(post({ platforms: [], caption: "" }))).toBe(`Untitled post, ${at("2026-11-20T15:00:00.000Z")}`);
  });

  it("two cards of a series, same caption, different times, have different names", () => {
    const nameOf = (html: string) => /aria-label="Looks good &quot;([^"]*)&quot;"[^>]*>Looks good<\/button>/.exec(html)?.[1];
    const a = nameOf(render(post({ id: "a", scheduledFor: "2026-11-20T15:00:00.000Z" })));
    const b = nameOf(render(post({ id: "b", scheduledFor: "2026-11-27T15:00:00.000Z" })));
    expect(a).toBe(`Sunday session, ${at("2026-11-20T15:00:00.000Z")}`);
    expect(b).toBe(`Sunday session, ${at("2026-11-27T15:00:00.000Z")}`);
  });
});
