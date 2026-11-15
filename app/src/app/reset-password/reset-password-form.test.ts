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
