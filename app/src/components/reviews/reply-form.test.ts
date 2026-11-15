import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplyForm } from "./reply-form";

// R17-client-journey addendum L1: Google takes at most 4096 bytes, so the box
// counts near the limit and will not post past it.
const TOO_LONG =
  "Your reply is too long for Google. Google allows 4,096 bytes, about 4,000 characters (emoji and accented letters count more). Shorten it and try again.";

function render(value: string): string {
  return renderToStaticMarkup(
    createElement(ReplyForm, {
      value,
      onChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
      onDraftAI: () => {},
      submitting: false,
      generatingAI: false,
    }),
  );
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
