import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VerifyEmailNotice, verifyEmailBannerShown } from "./verify-email-banner";
import { confirmEmailBannerShown, readWorkspaceStatus } from "./workspace-paused-banner";

/**
 * Fix round 1 (23): one banner per person. When the workspace banner asks an
 * unconfirmed address to confirm it (billing on), the older "Verify your
 * email" nudge stays hidden; otherwise the nudge behaves as before.
 */

const SENTENCE = "Confirm your email address to start posting. We sent a link to new@example.com.";

describe("verifyEmailBannerShown", () => {
  it("shows the nudge when the account check says so and the new banner is not up", () => {
    expect(verifyEmailBannerShown(true, false)).toBe(true);
    expect(verifyEmailBannerShown(false, false)).toBe(false);
  });

  it("hides the nudge while the new banner asks the same person to confirm", () => {
    expect(verifyEmailBannerShown(true, true)).toBe(false);
  });
});

describe("confirmEmailBannerShown", () => {
  it("is true only for the status route's unconfirmed-address answer", () => {
    expect(confirmEmailBannerShown(readWorkspaceStatus({ blockedMessage: SENTENCE, emailUnconfirmed: true }))).toBe(true);
  });

  it("is false for every answer the route gives with billing off", () => {
    for (const data of [
      { blockedMessage: null },
      { blockedMessage: "This workspace is paused. Contact us." },
      null,
    ]) {
      expect(confirmEmailBannerShown(readWorkspaceStatus(data))).toBe(false);
    }
  });
});

// R8-new-customer L3: with billing off this nudge is the only one, so it names
// the address and where to fix a mistyped one (as the workspace banner does).
describe("VerifyEmailNotice", () => {
  const render = (email: string | null) =>
    renderToStaticMarkup(createElement(VerifyEmailNotice, { email, sending: false, onResend: () => {} }));

  it("names the address, offers Resend, and links Settings, Account for a wrong one", () => {
    const html = render("maria@gmial.com");
    expect(html).toContain("Verify your email: we sent a link to maria@gmial.com.");
    expect(html).toContain("Resend email");
    expect(html).toContain("Wrong address?");
    expect(html).toMatch(/<a[^>]*href="\/settings#account"[^>]*>Change it in Settings, Account<\/a>/);
  });

  it("without an address in the session: the sentence without one", () => {
    const html = render(null);
    expect(html).toContain("Verify your email: we sent you a link.");
    expect(html).toContain("Change it in Settings, Account");
  });
});

// R20 pages L2: a long address is one unbreakable word; at 375 px it ran out
// of the banner. The sentence may shrink and break inside the word.
describe("VerifyEmailNotice at phone width", () => {
  it("lets the sentence with the address wrap", () => {
    const html = renderToStaticMarkup(
      createElement(VerifyEmailNotice, { email: "marketing.department@coastalrealtygroup.com", sending: false, onResend: () => {} }),
    );
    expect(html).toMatch(/<span class="min-w-0 break-words text-foreground">Verify your email: we sent a link to marketing\.department@coastalrealtygroup\.com\.<\/span>/);
  });
});
