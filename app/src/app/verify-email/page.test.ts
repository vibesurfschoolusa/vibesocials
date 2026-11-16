import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import VerifyEmailPage, { metadata } from "./page";
import { VerifyResult } from "./verify-email-client";
import { verifyView } from "./verifyOutcome";

const idle = { sending: false, result: null };
const noop = () => {};

describe("verify-email page", () => {
  // R5 pages L11 and L13.
  it("names the tab with the product and sits in a main landmark", () => {
    expect(metadata.title).toBe("Verify your email | Vibe Socials");
    expect(renderToStaticMarkup(VerifyEmailPage() as ReactElement)).toMatch(/<main[ >]/);
  });

  // R5 new-customer L3.
  it("offers a new link to a signed-in person whose link expired, without a login link", () => {
    const html = renderToStaticMarkup(
      createElement(VerifyResult, { view: verifyView("invalid", "unverified"), resend: idle, onResend: noop, onRetry: noop }),
    );
    expect(html).toMatch(/<button[^>]*>(<[^>]+>)*Send a new link/);
    expect(html).not.toContain('href="/login"');
  });

  it("offers Try again after a network failure", () => {
    const html = renderToStaticMarkup(
      createElement(VerifyResult, { view: verifyView("network", "unknown"), resend: idle, onResend: noop, onRetry: noop }),
    );
    expect(html).toContain("Try again");
    expect(html).not.toContain("isn&#x27;t valid");
  });

  it("shows the resend answer, and hides the button once a link was sent", () => {
    const html = renderToStaticMarkup(
      createElement(VerifyResult, {
        view: verifyView("invalid", "unverified"),
        resend: { sending: false, result: { ok: true, message: "We sent a new link." } },
        onResend: noop,
        onRetry: noop,
      }),
    );
    expect(html).toContain("We sent a new link.");
    expect(html).not.toMatch(/<button[^>]*>(<[^>]+>)*Send a new link/);
  });

  // R28 NN2 (pages L6, new-customer L4): "We sent a new link" appeared already
  // filled as the button went; the status region is on the card from the
  // first render, and only its text changes.
  // R30 lead review: the resend success is an Alert that announces itself (no region of its own).
  it("shows the resend success as a success Alert with no role of its own", () => {
    const view = verifyView("invalid", "unverified");
    const before = renderToStaticMarkup(createElement(VerifyResult, { view, resend: idle, onResend: noop, onRetry: noop }));
    expect(before).not.toContain("We sent a new link.");
    const after = renderToStaticMarkup(
      createElement(VerifyResult, {
        view,
        resend: { sending: false, result: { ok: true, message: "We sent a new link." } },
        onResend: noop,
        onRetry: noop,
      }),
    );
    expect(after).toMatch(/<div class="[^"]*bg-success\/10[^"]*"><span[\s\S]*We sent a new link\./);
    expect(after).not.toContain('role="status"');
  });
});
