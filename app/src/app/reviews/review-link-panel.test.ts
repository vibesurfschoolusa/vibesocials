import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

import { qrSvg } from "@/lib/qrSvg";

import { ReviewLinkPanelView, reviewRequestMessage } from "./review-link-panel";

const LINK = "https://g.page/r/abc/review";
const render = (state: Parameters<typeof ReviewLinkPanelView>[0]["state"], workspaceId = "ws-A", isMember = false) =>
  renderToStaticMarkup(createElement(ReviewLinkPanelView, { state, workspaceId, isMember }));

describe("reviewRequestMessage", () => {
  // R5 pages L5: any business sends it, so it names no activity.
  it("is the message to send a customer, with the link, fit for any business", () => {
    expect(reviewRequestMessage(LINK)).toBe(
      `Thank you for choosing us! If you have a minute, a quick Google review helps us a lot: ${LINK}`,
    );
  });
});

describe("ReviewLinkPanelView", () => {
  it("shows the link with Copy, its QR code, a Print card button and the message with Copy", () => {
    const html = render({ status: "ready", url: LINK });

    expect(html).toContain("Get more reviews");
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain(qrSvg(LINK));
    expect(html).toContain('href="/reviews/print-card"');
    expect(html).toContain("Print card");
    expect(html).toContain(reviewRequestMessage(LINK));
    expect(html.match(/>Copy link</g)).toHaveLength(1);
    expect(html.match(/>Copy message</g)).toHaveLength(1);
  });

  it("says what to do in one line when there is no link", () => {
    const html = render({ status: "none", reason: "Choose your Maps location in Settings." });

    expect(html).toContain("Get more reviews");
    expect(html).toContain("Choose your Maps location in Settings.");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Print card");
  });

  // JJ3 lead review: an owner's in-place Google sign-in, for the page's own workspace.
  it("offers Sign in to Google again for the page's workspace when the route says so", () => {
    const html = render({ status: "none", reason: "Google didn't accept the connection.", signIn: true }, "ws-A");
    expect(html).toMatch(/<a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-A"[^>]*>Sign in to Google again <span[^>]*>\(opens in a new tab\)<\/span><\/a>/);
    expect(render({ status: "none", reason: "Something else." })).not.toContain("/api/auth/");
  });

  // R25 lead review: when the reviews card above already offers the sign-in,
  // the panel says its sentence but no second button.
  it("leaves the sign-in out when the page's error card already shows it", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLinkPanelView, {
        state: { status: "none", reason: "Google no longer accepts this connection.", signIn: true },
        workspaceId: "ws-A",
        isMember: false,
        signInShownAbove: true,
      }),
    );
    expect(html).not.toContain("/api/auth/");
    expect(html).toContain("Google no longer accepts this connection.");
  });

  // JJ3 lead review: the page's own member flag decides, as the error card does.
  it("never shows the sign-in link on a member's page, even if an answer asks", () => {
    const html = render({ status: "none", reason: "Google didn't accept the connection.", signIn: true }, "ws-A", true);
    expect(html).not.toContain("/api/auth/");
    expect(html).toContain("Google didn&#x27;t accept the connection.");
  });

  it("shows a placeholder while loading", () => {
    const html = render({ status: "loading" });

    expect(html).toContain("Get more reviews");
    expect(html).not.toContain("<svg");
  });
});
