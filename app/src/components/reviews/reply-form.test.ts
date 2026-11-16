import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_REPLY_BOXES,
  RESTORED_STATUS,
  ReplyForm,
  focusBoxAfterDraft,
  focusPlace,
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

  it("a draft from this form's Draft button: the box takes focus when it lands, if focus is still here or dropped", () => {
    expect(focusBoxAfterDraft(true, true, "this form")).toBe(false); // still drafting
    expect(focusBoxAfterDraft(false, true, "this form")).toBe(true);
    // The disabled Draft button drops focus to the page body.
    expect(focusBoxAfterDraft(false, true, "body")).toBe(true);
  });

  it("lead review: focus the person moved elsewhere (another card's Draft) stays there", () => {
    expect(focusBoxAfterDraft(false, true, "elsewhere")).toBe(false);
  });

  it("a draft from the card's Draft button, or for another review, never moves focus", () => {
    for (const place of ["this form", "body", "elsewhere"] as const) {
      expect(focusBoxAfterDraft(false, false, place)).toBe(false);
      expect(focusBoxAfterDraft(true, false, place)).toBe(false);
    }
  });
});

describe("ReplyForm: where focus is", () => {
  const body = { contains: () => true };
  const form = { contains: (node: unknown) => node === inside };
  const inside = { contains: () => false };
  const other = { contains: () => false };

  it("nothing focused, or the page body: body", () => {
    expect(focusPlace(null, form, body)).toBe("body");
    expect(focusPlace(body, form, body)).toBe("body");
  });

  it("an element inside this form: this form", () => {
    expect(focusPlace(inside, form, body)).toBe("this form");
  });

  it("anything else: elsewhere", () => {
    expect(focusPlace(other, form, body)).toBe("elsewhere");
    expect(focusPlace(other, null, body)).toBe("elsewhere");
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

  function landed(draftedHere: { current: boolean }, place: "this form" | "body" | "elsewhere", drafting = false) {
    const focusBox = vi.fn();
    settleDraftFocus({ drafting, draftedHere, where: () => place, focusBox });
    return focusBox;
  }

  it("this form's draft lands with focus dropped to the body: the box takes focus, once", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "body")).toHaveBeenCalledTimes(1);
    expect(draftedHere.current).toBe(false);
    expect(landed(draftedHere, "body")).not.toHaveBeenCalled();
  });

  it("this form's draft lands while focus is on another card: focus stays, and the mark is cleared", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "elsewhere")).not.toHaveBeenCalled();
    expect(draftedHere.current).toBe(false);
  });

  it("while the draft is still being written nothing happens and the mark stays", () => {
    const draftedHere = { current: true };
    expect(landed(draftedHere, "body", true)).not.toHaveBeenCalled();
    expect(draftedHere.current).toBe(true);
  });

  it("a draft from the card (no mark): never moves focus", () => {
    expect(landed({ current: false }, "body")).not.toHaveBeenCalled();
    expect(landed({ current: false }, "this form")).not.toHaveBeenCalled();
  });

  it("the box keeps its id, for the label", () => {
    expect(textarea(render("Hi"))).toContain('id="review-reply"');
  });
});
