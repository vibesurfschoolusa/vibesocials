import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DraftAIButton,
  EMPTY_REPLY_BOXES,
  draftButtonId,
  draftClick,
  focusBoxAfterCardDraft,
  RESTORED_STATUS,
  ReplyForm,
  focusBoxAfterDraft,
  focusPlace,
  focusBoxOnOpen,
  replyRefusalAfterFailure,
  replyRefusalCleared,
  replyRefusalMessage,
  replyRefusalWhileOpen,
  replySignInHref,
  replyUndoStatus,
  settleDraftFocus,
  startDraftHere,
  undoReply,
  draftingAfterEnd,
  draftingAfterStart,
  openAfterDraft,
  replyBoxAfterDraft,
  replyBoxAfterPost,
  replyBoxAfterTyping,
  replyBoxAfterUndo,
  hasTypedReply,
} from "./reply-form";

// R17-client-journey addendum L1: Google takes at most 4096 bytes, so the box
// counts near the limit and will not post past it.
const TOO_LONG =
  "Your reply is too long for Google. Google allows 4,096 bytes, about 4,000 characters (emoji and accented letters count more). Shorten it and try again.";

function render(value: string, generatingAI = false): string {
  return renderToStaticMarkup(
    createElement(ReplyForm, {
      value,
      onChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
      onDraftAI: () => {},
      submitting: false,
      generatingAI,
    }),
  );
}

function textarea(html: string): string {
  const match = html.match(/<textarea[^>]*>/);
  expect(match, "reply box").not.toBeNull();
  return match![0];
}

function postButton(html: string): string {
  const match = html.match(/<button[^>]*>(?:(?!<\/button>).)*Post reply<\/button>/);
  expect(match, "Post reply button").not.toBeNull();
  return match![0];
}

describe("ReplyForm and Google's length limit", () => {
  it("shows no counter for a short reply and Post works", () => {
    const html = render("Thanks for visiting!");
    expect(html).not.toContain("bytes used");
    expect(html).not.toContain(TOO_LONG);
    expect(postButton(html)).not.toMatch(/disabled=""/);
  });

  it("shows the counter near the limit, Post still works", () => {
    const html = render("a".repeat(3800));
    expect(html).toContain("3,800 of 4,096 bytes used.");
    expect(postButton(html)).not.toMatch(/disabled=""/);
  });

  it("an AI draft over the limit shows the counter and the reason, and cannot be posted", () => {
    const draft = "Thank you so much for the lovely review! ".repeat(110); // ~4,500 bytes
    const html = render(draft);
    expect(html).toMatch(/\d,\d{3} of 4,096 bytes used\./);
    expect(html).toContain(TOO_LONG);
    expect(postButton(html)).toMatch(/disabled=""/);
    expect(html).toContain('aria-invalid="true"');
  });

  it("counts bytes, not characters: accents over the limit are refused", () => {
    const html = render("é".repeat(2100));
    expect(html).toContain("4,200 of 4,096 bytes used.");
    expect(postButton(html)).toMatch(/disabled=""/);
  });
});

// R23 client-journey L3: the AI draft fills the box when it arrives, so the box
// takes no typing meanwhile and says why; nothing typed is overwritten.
describe("ReplyForm while an AI draft is being written", () => {
  const STATUS = "Writing a draft. You can edit it here as soon as it is ready.";

  it("locks the box, says why and holds Post until the draft is in", () => {
    const html = render("Thanks", true);
    expect(textarea(html)).toMatch(/readOnly=""/i);
    expect(textarea(html)).toContain('aria-busy="true"');
    expect(html).toContain(STATUS);
    expect(html).toMatch(/role="status"/);
    expect(postButton(html)).toMatch(/disabled=""/);
  });

  it("an open box takes typing and says nothing when no draft is being written", () => {
    const html = render("Thanks");
    expect(textarea(html)).not.toMatch(/readOnly/i);
    expect(textarea(html)).not.toContain("aria-busy");
    expect(html).not.toContain(STATUS);
  });
});

// Lead follow-up to R23 client-journey L3: a draft may replace typed text, but
// the text is kept and Undo brings it back until the person types or posts.
describe("ReplyForm: Undo after a draft replaces typed text", () => {
  const UNDO_STATUS = "Draft written. Undo to get your text back.";
  const typed = "Thanks Maria!\n  See you  soon ";

  it("typed text -> Draft -> Undo restores it exactly", () => {
    let boxes = replyBoxAfterTyping(EMPTY_REPLY_BOXES, "r1", typed);
    boxes = replyBoxAfterDraft(boxes, "r1", "Thank you for the lovely review!");
    expect(boxes.text.r1).toBe("Thank you for the lovely review!");
    expect(boxes.undo.r1).toBe(typed);

    boxes = replyBoxAfterUndo(boxes, "r1");
    expect(boxes.text.r1).toBe(typed);
    expect(boxes.undo.r1).toBeUndefined();
  });

  it("no text -> Draft -> no Undo", () => {
    const boxes = replyBoxAfterDraft(EMPTY_REPLY_BOXES, "r1", "Thank you!");
    expect(boxes.text.r1).toBe("Thank you!");
    expect(boxes.undo.r1).toBeUndefined();
  });

  it("typing again or posting ends the Undo", () => {
    const drafted = replyBoxAfterDraft(replyBoxAfterTyping(EMPTY_REPLY_BOXES, "r1", typed), "r1", "Draft");
    const edited = replyBoxAfterTyping(drafted, "r1", "Draft!");
    expect(edited.undo.r1).toBeUndefined();
    expect(edited.text.r1).toBe("Draft!");

    const posted = replyBoxAfterPost(drafted, "r1");
    expect(posted.undo.r1).toBeUndefined();
    expect(posted.text.r1).toBe("");
  });

  it("a second draft keeps the person's own text, not the first draft", () => {
    let boxes = replyBoxAfterDraft(replyBoxAfterTyping(EMPTY_REPLY_BOXES, "r1", typed), "r1", "Draft one");
    boxes = replyBoxAfterDraft(boxes, "r1", "Draft two");
    expect(replyBoxAfterUndo(boxes, "r1").text.r1).toBe(typed);
  });

  it("another review's box is left alone", () => {
    let boxes = replyBoxAfterTyping(EMPTY_REPLY_BOXES, "r2", "Mine");
    boxes = replyBoxAfterDraft(replyBoxAfterTyping(boxes, "r1", typed), "r1", "Draft");
    expect(replyBoxAfterUndo(boxes, "r1").text.r2).toBe("Mine");
  });

  function renderWith(onUndoDraft?: () => void): string {
    return renderToStaticMarkup(
      createElement(ReplyForm, {
        value: "Draft",
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
        onDraftAI: () => {},
        onUndoDraft,
        submitting: false,
        generatingAI: false,
      }),
    );
  }

  it("shows the status and an Undo button while the text can be restored", () => {
    const html = renderWith(() => {});
    expect(html).toContain(UNDO_STATUS);
    expect(html).toMatch(/<button[^>]*>Undo<\/button>/);
  });

  it("shows neither when there is nothing to restore", () => {
    const html = renderWith(undefined);
    expect(html).not.toContain(UNDO_STATUS);
    expect(html).not.toMatch(/>Undo</);
  });
});

// Lead review follow-up: both live regions stay on the page and only their
// text changes, so screen readers announce the change.
describe("ReplyForm: the two status lines are always there", () => {
  function statuses(generatingAI: boolean, onUndoDraft?: () => void): string[] {
    const html = renderToStaticMarkup(
      createElement(ReplyForm, {
        value: "Draft",
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
        onDraftAI: () => {},
        onUndoDraft,
        submitting: false,
        generatingAI,
      }),
    );
    return [...html.matchAll(/<p[^>]*role="status"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
  }

  it("idle: two empty status lines", () => {
    expect(statuses(false)).toEqual(["", ""]);
  });

  it("drafting: the first says so, the second is empty", () => {
    expect(statuses(true, () => {})).toEqual([
      "Writing a draft. You can edit it here as soon as it is ready.",
      "",
    ]);
  });

  it("after a draft replaced text: the second offers Undo", () => {
    expect(statuses(false, () => {})).toEqual(["", "Draft written. Undo to get your text back."]);
  });
});

// Lead review follow-up: several drafts can run at once; each box stays locked
// until its own draft lands or fails.
describe("the reviews being drafted", () => {
  it("a second draft keeps the first locked, and each ends on its own", () => {
    let drafting = draftingAfterStart(new Set<string>(), "r1");
    drafting = draftingAfterStart(drafting, "r2");
    expect([...drafting].sort()).toEqual(["r1", "r2"]);

    drafting = draftingAfterEnd(drafting, "r2");
    expect(drafting.has("r1")).toBe(true);
    expect(drafting.has("r2")).toBe(false);

    drafting = draftingAfterEnd(drafting, "r1");
    expect(drafting.size).toBe(0);
  });

  it("never changes the set it was given", () => {
    const before = new Set(["r1"]);
    draftingAfterStart(before, "r2");
    draftingAfterEnd(before, "r1");
    expect([...before]).toEqual(["r1"]);
  });
});

// Lead review (R23): a draft that lands while another review's box is open
// stays with its own review; the open box, its text and its focus are left alone.
describe("which box is open after a draft lands", () => {
  it("opens the drafted review's box when none is open", () => {
    expect(openAfterDraft(null, "A")).toBe("A");
  });

  it("keeps its own box open", () => {
    expect(openAfterDraft("A", "A")).toBe("A");
  });

  it("leaves another review's open box open", () => {
    expect(openAfterDraft("B", "A")).toBe("B");
  });

  it("A's draft and its Undo wait with A while B keeps its text", () => {
    let boxes = replyBoxAfterTyping(EMPTY_REPLY_BOXES, "A", "My words for A");
    boxes = replyBoxAfterTyping(boxes, "B", "Typing for B");
    boxes = replyBoxAfterDraft(boxes, "A", "Draft for A");
    expect(boxes.text).toEqual({ A: "Draft for A", B: "Typing for B" });
    expect(boxes.undo).toEqual({ A: "My words for A" });
  });
});

// R24 pages L2: Undo removes its own button, so focus went to the page body and
// nothing was said. Undo now puts focus in the box and says the text is back;
// a draft asked for with this form's own Draft button gives focus back to the
// box when it lands. A draft from the card, or for another review, never
// moves focus.
describe("ReplyForm: focus and status after Undo and a draft", () => {
  it("after Undo the status says the text is back", () => {
    expect(RESTORED_STATUS).toBe("Your text is back.");
    expect(replyUndoStatus(false, true)).toBe(RESTORED_STATUS);
  });

  it("while Undo is offered it says so, even after an earlier Undo", () => {
    expect(replyUndoStatus(true, false)).toBe("Draft written. Undo to get your text back.");
    expect(replyUndoStatus(true, true)).toBe("Draft written. Undo to get your text back.");
  });

  it("with nothing to undo and no Undo done it says nothing", () => {
    expect(replyUndoStatus(false, false)).toBe("");
  });

  it("a draft from this form's Draft button: the box takes focus when it lands, while focus is still in this form", () => {
    expect(focusBoxAfterDraft(true, true, "this form")).toBe(false); // still drafting
    expect(focusBoxAfterDraft(false, true, "this form")).toBe(true);
  });

  it("lead review: focus the person moved elsewhere (another card's Draft) stays there", () => {
    expect(focusBoxAfterDraft(false, true, "elsewhere")).toBe(false);
  });

  it("a draft from the card's Draft button, or for another review, never moves focus", () => {
    for (const place of ["this form", "elsewhere"] as const) {
      expect(focusBoxAfterDraft(false, false, place)).toBe(false);
      expect(focusBoxAfterDraft(true, false, place)).toBe(false);
    }
  });
});

// JJ3 second review: the Draft buttons stay focusable while they write, so
// focus never drops to the body, and "body" no longer counts as this form's.
describe("ReplyForm: where focus is", () => {
  const inside = { id: "inside" };
  const form = { contains: (node: unknown) => node === inside };
  const body = { id: "body" };
  const other = { id: "other" };

  it("an element inside this form: this form", () => {
    expect(focusPlace(inside, form)).toBe("this form");
  });

  it("nothing focused, the page body, or anything else: elsewhere", () => {
    expect(focusPlace(null, form)).toBe("elsewhere");
    expect(focusPlace(body, form)).toBe("elsewhere");
    expect(focusPlace(other, form)).toBe("elsewhere");
    expect(focusPlace(inside, null)).toBe("elsewhere");
  });
});

// JJ3 lead review: a draft from the card's Draft button opens the form, and
// that button leaves, so focus would drop to the body. When focus was on that
// very button as the draft landed, the new box takes it (the person's own
// action); anywhere else, focus is left alone.
describe("a draft from the card's Draft button lands", () => {
  it("focus on that card's Draft button, and its box opened: the new box takes focus", () => {
    expect(focusBoxAfterCardDraft(draftButtonId("r1"), "r1", "r1")).toBe(true);
  });

  it("focus anywhere else, or nowhere: left alone", () => {
    expect(focusBoxAfterCardDraft(undefined, "r1", "r1")).toBe(false);
    expect(focusBoxAfterCardDraft("", "r1", "r1")).toBe(false);
    expect(focusBoxAfterCardDraft("something-else", "r1", "r1")).toBe(false);
    expect(focusBoxAfterCardDraft(draftButtonId("r2"), "r1", "r1")).toBe(false);
  });

  it("another review's box stayed open: left alone, even from its own button", () => {
    expect(focusBoxAfterCardDraft(draftButtonId("r1"), "r1", "r2")).toBe(false);
    expect(focusBoxAfterCardDraft(draftButtonId("r1"), "r1", null)).toBe(false);
  });

  it("the Draft button carries the id the rule looks for", () => {
    const html = renderToStaticMarkup(
      createElement(DraftAIButton, { drafting: true, onDraft: () => {}, id: draftButtonId("r1") }),
    );
    expect(html).toContain(`id="${draftButtonId("r1")}"`);
    expect(draftButtonId("r1")).not.toBe(draftButtonId("r2"));
  });
});

describe("the Draft button while it writes (form and card)", () => {
  function draftButton(drafting: boolean): string {
    const html = renderToStaticMarkup(createElement(DraftAIButton, { drafting, onDraft: () => {} }));
    const match = html.match(/<button[^>]*>/);
    expect(match, "Draft button").not.toBeNull();
    return match![0];
  }

  it("stays focusable: aria-disabled and aria-busy, never disabled", () => {
    const tag = draftButton(true);
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).toContain('aria-busy="true"');
  });

  // Lead review: the base aria-disabled:cursor-not-allowed (button.tsx) must
  // not replace this button's progress cursor while it writes.
  it("while it writes: the progress cursor, not the not-allowed one", () => {
    const tag = draftButton(true);
    expect(tag).toContain("aria-disabled:cursor-progress");
    expect(tag).not.toContain("cursor-not-allowed");
  });

  it("idle: neither attribute", () => {
    const tag = draftButton(false);
    // The attribute, not the class: buttonVariants styles aria-disabled buttons.
    expect(tag).not.toMatch(/\saria-disabled=/);
    expect(tag).not.toContain("aria-busy");
  });

  it("says what it is doing", () => {
    expect(renderToStaticMarkup(createElement(DraftAIButton, { drafting: true, onDraft: () => {} }))).toContain("Generating…");
    expect(renderToStaticMarkup(createElement(DraftAIButton, { drafting: false, onDraft: () => {} }))).toContain("Draft AI response");
  });

  it("pressing it again while it writes does nothing", () => {
    const onDraft = vi.fn();
    draftClick(true, onDraft)();
    expect(onDraft).not.toHaveBeenCalled();
    draftClick(false, onDraft)();
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it("the form's Draft button is this one", () => {
    const tag = render("Hi", true).match(/<button[^>]*aria-busy="true"[^>]*>/);
    expect(tag, "busy Draft button").not.toBeNull();
    expect(tag![0]).toContain('aria-disabled="true"');
    expect(tag![0]).not.toMatch(/\sdisabled=""/);
  });
});

// Lead review follow-up: the handlers and the effect's decision, as far as a
// test without a DOM can drive them.
describe("ReplyForm: the Undo, Draft and draft-landed wiring", () => {
  it("Undo restores the text, says it is back and focuses the box, in that order", () => {
    const calls: string[] = [];
    undoReply({
      onUndoDraft: () => calls.push("undo"),
      setRestored: (value) => calls.push(`restored:${value}`),
      focusBox: () => calls.push("focus"),
    });
    expect(calls).toEqual(["undo", "restored:true", "focus"]);
  });

  it("Undo then reads 'Your text is back.' in the status line", () => {
    expect(replyUndoStatus(false, true)).toBe("Your text is back.");
  });

  it("this form's Draft button marks the draft as this form's and clears 'Your text is back.'", () => {
    const draftedHere = { current: false };
    const calls: string[] = [];
    startDraftHere({
      draftedHere,
      setRestored: (value) => calls.push(`restored:${value}`),
      onDraftAI: () => calls.push("draft"),
    });
    expect(draftedHere.current).toBe(true);
    expect(calls).toEqual(["restored:false", "draft"]);
  });

  function landed(draftedHere: { current: boolean }, place: "this form" | "elsewhere", drafting = false) {
    const focusBox = vi.fn();
    settleDraftFocus({ drafting, draftedHere, where: () => place, focusBox });
    return focusBox;
  }

  it("this form's draft lands (or fails) with focus still on its Draft button: the box takes focus, once", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "this form")).toHaveBeenCalledTimes(1);
    expect(draftedHere.current).toBe(false);
    expect(landed(draftedHere, "this form")).not.toHaveBeenCalled();
  });

  it("this form's draft lands after the person tabbed elsewhere: focus stays", () => {
    expect(landed({ current: true }, "elsewhere")).not.toHaveBeenCalled();
  });

  it("this form's draft lands while focus is on another card: focus stays, and the mark is cleared", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "elsewhere")).not.toHaveBeenCalled();
    expect(draftedHere.current).toBe(false);
  });

  it("while the draft is still being written nothing happens and the mark stays", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "this form", true)).not.toHaveBeenCalled();
    expect(draftedHere.current).toBe(true);
  });

  it("a draft from the card (no mark): never moves focus", () => {
    expect(landed({ current: false }, "elsewhere")).not.toHaveBeenCalled();
    expect(landed({ current: false }, "this form")).not.toHaveBeenCalled();
  });

  it("the box keeps its id, for the label", () => {
    expect(textarea(render("Hi"))).toContain('id="review-reply"');
  });
});

// JJ3 lead review, R25 pages L4: a refused reply keeps its sentence in that
// form's status line (a toast vanishes), and, when Google wants the owner to
// sign in again, the in-place sign-in link, until the person types, sends
// again or closes the form.
describe("a reply Google refused", () => {
  const signIn = { message: "Sign in to Google again with the account that manages this location.", settingsLink: true, signIn: true as const };
  const other = { message: "Couldn't post your reply. Try again in a minute.", settingsLink: false };

  it("keeps the sentence for that review's form only", () => {
    const refused = replyRefusalAfterFailure("r1", other, false);
    expect(replyRefusalMessage(refused, "r1")).toBe(other.message);
    expect(replyRefusalMessage(refused, "r2")).toBeUndefined();
    expect(replyRefusalMessage(null, "r1")).toBeUndefined();
  });

  it("on an owner's page: the link shows for that review, with the page's workspace id", () => {
    const refused = replyRefusalAfterFailure("r1", signIn, false);
    expect(replyRefusalMessage(refused, "r1")).toBe(signIn.message);
    expect(replySignInHref(refused, "r1", "ws-A")).toBe("/api/auth/google_business_profile/start?workspaceId=ws-A");
    expect(replySignInHref(refused, "r2", "ws-A")).toBeUndefined();
  });

  it("on a member's page: the sentence, never the link", () => {
    const refused = replyRefusalAfterFailure("r1", signIn, true);
    expect(replyRefusalMessage(refused, "r1")).toBe(signIn.message);
    expect(replySignInHref(refused, "r1", "ws-A")).toBeUndefined();
  });

  it("another kind of failure: no link", () => {
    expect(replySignInHref(replyRefusalAfterFailure("r1", other, false), "r1", "ws-A")).toBeUndefined();
  });

  it("clears when the person types, sends again or closes the form (that review only)", () => {
    const refused = replyRefusalAfterFailure("r1", signIn, false);
    expect(replyRefusalCleared(refused, "r1")).toBeNull();
    expect(replyRefusalCleared(refused, "r2")).toBe(refused);
    expect(replyRefusalCleared(null, "r1")).toBeNull();
  });

  // Lead review: Reply on another review closes this form without Cancel; any
  // way a form closes clears its sentence and link, so reopening it is clean.
  it("is kept only while its own review's form is the open one", () => {
    const refused = replyRefusalAfterFailure("r1", signIn, false);
    expect(replyRefusalWhileOpen(refused, "r1")).toBe(refused);
    expect(replyRefusalWhileOpen(refused, "r2")).toBeNull();
    expect(replyRefusalWhileOpen(refused, null)).toBeNull();
    expect(replyRefusalWhileOpen(null, "r1")).toBeNull();
  });

  it("the form shows the sentence inside a status region, so it is announced, and stays on the page", () => {
    const html = renderToStaticMarkup(
      createElement(ReplyForm, {
        value: "Thanks",
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
        onDraftAI: () => {},
        submitting: false,
        generatingAI: false,
        refusal: "Couldn't post your reply. Try again in a minute.",
      }),
    );
    expect(html).toMatch(/<div[^>]*role="status"[^>]*><p[^>]*>Couldn&#x27;t post your reply\. Try again in a minute\.<\/p><\/div>/);
    expect(render("Thanks")).toMatch(/<div[^>]*role="status"[^>]*class="[^"]*empty:sr-only[^"]*"[^>]*><\/div>/);
  });

  it("the form shows the link after the sentence, inside the same status region", () => {
    const html = renderToStaticMarkup(
      createElement(ReplyForm, {
        value: "Thanks",
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
        onDraftAI: () => {},
        submitting: false,
        generatingAI: false,
        refusal: "Sign in to Google again with the account that manages this location.",
        signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A",
      }),
    );
    expect(html).toMatch(
      /<div[^>]*role="status"[^>]*><p[^>]*>Sign in to Google again with the account that manages this location\.<\/p><a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-A"[^>]*>Sign in to Google again <span[^>]*>\(opens in a new tab\)<\/span><\/a><\/div>/,
    );
    expect(render("Thanks")).not.toContain("/api/auth/");
  });
});

// R25 pages L1: "Reply to review" swaps itself for the form, and Cancel swaps
// the form back, so focus would fall to the page body. Reply hands focus to
// the box; Cancel to that review's Reply button (the page's pendingFocus).
describe("focus when the form opens from Reply", () => {
  it("the box takes focus once the review asked for is the open one", () => {
    expect(focusBoxOnOpen("r1", "r1")).toBe(true);
  });

  it("nothing asked for (a form a draft opened), or another review open: focus stays", () => {
    expect(focusBoxOnOpen(null, "r1")).toBe(false);
    expect(focusBoxOnOpen("r1", "r2")).toBe(false);
    expect(focusBoxOnOpen("r1", null)).toBe(false);
  });
});

// R27 lead's second review: a refused page says to copy typed text whenever a box holds some.
describe("hasTypedReply", () => {
  it("is true when any box holds more than spaces", () => {
    expect(hasTypedReply({})).toBe(false);
    expect(hasTypedReply({ a: "", b: "   " })).toBe(false);
    expect(hasTypedReply({ a: "", b: "Thanks!" })).toBe(true);
  });
});

// R57 pages-b L3: the card's Draft AI response names its reviewer; the one
// inside the open reply form sits under that review's own "Your reply".
describe("DraftAIButton's name", () => {
  it("names the reviewer when given one, starting with its text", () => {
    const html = renderToStaticMarkup(createElement(DraftAIButton, { drafting: false, onDraft: () => {}, reviewer: "Maria Lopez" }));
    expect(html).toContain('aria-label="Draft AI response to the review by Maria Lopez"');
  });

  it("has no name of its own without one", () => {
    expect(renderToStaticMarkup(createElement(DraftAIButton, { drafting: false, onDraft: () => {} }))).not.toContain("aria-label");
  });
});
