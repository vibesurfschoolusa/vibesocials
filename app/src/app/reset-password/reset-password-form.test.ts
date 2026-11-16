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

// R28 NN2 (pages L6, new-customer L4): "Password updated" replaced the form
// with a success line that appeared already filled. The status region is in
// the card from the first render of the form, and only its text changes.
describe("Reset password success line", () => {
  const source = readFileSync(join(__dirname, "reset-password-form.tsx"), "utf8");

  it("the form and the done card both start with the same status region", () => {
    const form = source.slice(source.indexOf('<CardShell title="Choose a new password"'));
    expect(form).toMatch(/^<CardShell title="Choose a new password"[^>]*>\s+\{statusLine\}\s+<form/);
    const done = source.slice(source.indexOf("if (done) {"), source.indexOf('<CardShell title="Choose a new password"'));
    expect(done).toMatch(/<CardShell[^>]*>\s+\{statusLine\}/);
    const region = source.slice(source.indexOf("const statusLine = ("), source.indexOf("if (!tokenReady)"));
    expect(region).toContain('<div role="status" className="empty:sr-only">');
    expect(region).toMatch(/done \? \(\s+<Alert variant="success" role=\{undefined\}[^>]*>\s+You can now log in with your new password\./);
  });

  it("sends through fetchOrNoAnswer", () => {
    const outcome = readFileSync(join(__dirname, "resetOutcome.ts"), "utf8");
    expect(outcome).toMatch(/await fetchOrNoAnswer\(\s*"\/api\/auth\/reset-password"/);
  });
});
