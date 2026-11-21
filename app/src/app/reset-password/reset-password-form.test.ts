import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeadLinkCard } from "./reset-password-form";

// R16-pages L3: pressing Reset password on a used or expired link swaps the
// form for this card; the explanation is announced, as the old 400 text was.
describe("DeadLinkCard", () => {
  it("after a submit, says why in an alert", () => {
    const html = renderToStaticMarkup(createElement(DeadLinkCard, { afterSubmit: true }));
    expect(html).toMatch(/role="alert"[^>]*>[\s\S]*This password reset link is invalid or has expired\./);
    expect(html).toContain("This link isn&#x27;t valid");
    expect(html).toMatch(/href="\/forgot-password"[^>]*>Request a new link</);
  });

  it("arriving on a dead link, is a plain page with nothing to interrupt", () => {
    const html = renderToStaticMarkup(createElement(DeadLinkCard, { afterSubmit: false }));
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("This password reset link is invalid or has expired.");
    expect(html).toMatch(/href="\/forgot-password"[^>]*>Request a new link</);
  });
});

// R55 new-customer L1, pages-a L1: a newer request cancels an older link, so
// the card says to open the newest email, arriving or after a submit.
describe("DeadLinkCard: the newest email", () => {
  it("says to open the newest email in both states", () => {
    for (const afterSubmit of [true, false]) {
      const html = renderToStaticMarkup(createElement(DeadLinkCard, { afterSubmit }));
      expect(html).toContain("If you asked for a link more than once, open the newest email.");
    }
  });
});

// R28 NN2 (pages L6, new-customer L4): "Password updated" replaced the form
// with a success line that appeared already filled. The status region is in
// the card from the first render of the form, and only its text changes.
describe("Reset password success line", () => {
  const source = readFileSync(join(__dirname, "reset-password-form.tsx"), "utf8");

  // R30 PP2: one card with one return; statusLines.guard.test.ts keeps the region out of any branch.
  it("the card starts with the success Alert, which announces itself", () => {
    const card = source.slice(source.indexOf("function ResetPasswordCard("));
    expect(card.match(/\breturn \(/g)).toHaveLength(1);
    // R30 lead review: the success Alert announces itself (no region of its own).
    expect(card).toMatch(/<CardShell[\s\S]*?>\s+(\{\/\*[^\n]*\*\/\}\s+)?\{done \? \(\s+<Alert variant="success" className="mb-4">\s+You can now log in with your new password\./);
    expect(card).not.toContain('role="status"');
  });

  it("sends through fetchOrNoAnswer", () => {
    const outcome = readFileSync(join(__dirname, "resetOutcome.ts"), "utf8");
    expect(outcome).toMatch(/await fetchOrNoAnswer\(\s*"\/api\/auth\/reset-password"/);
  });
});
