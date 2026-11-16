import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EMPTY_REPLY_BOXES,
  ReplyForm,
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
