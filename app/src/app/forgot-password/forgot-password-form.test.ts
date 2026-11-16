import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ForgotPasswordForm } from "./forgot-password-form";

const source = readFileSync(join(__dirname, "forgot-password-form.tsx"), "utf8");

// R28 NN2 (pages L6, new-customer L4): the confirmation appeared already
// filled, in place of the form, so a screen reader may not hear it. The status
// region is on the page from the first render and only its text changes.
describe("Forgot password form", () => {
  it("renders an empty status region before any press", () => {
    expect(renderToStaticMarkup(createElement(ForgotPasswordForm))).toMatch(/<div role="status" class="empty:sr-only"><\/div>/);
  });

  it("the confirmation sits inside that region", () => {
    const region = source.indexOf('<div role="status" className="empty:sr-only">');
    expect(region).toBeGreaterThan(-1);
    expect(source.indexOf("If an account exists for that address, we sent a reset link.")).toBeGreaterThan(region);
    expect(source).not.toMatch(/if \(submitted\) \{\s+return \(/);
  });

  // R28 NN2 (new-customer L3): the route's 400 sentence reaches the outcome.
  it("sends through fetchOrNoAnswer and hands the answer's body to the outcome", () => {
    expect(source).toMatch(/await fetchOrNoAnswer\("\/api\/auth\/forgot-password"/);
    expect(source).toMatch(/forgotPasswordOutcome\(status, data\)/);
  });
});
