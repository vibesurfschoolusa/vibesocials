import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

import { qrSvg } from "@/lib/qrSvg";

import { WORKSPACE_CHANGED_RELOAD_MESSAGE } from "@/components/reviews/workspace-changed";

import { PrintCardLinkView, ReviewLinkPanelView, reviewLinkStateFrom, reviewRequestMessage } from "./review-link-panel";

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
    expect(html).toContain('href="/reviews/print-card?workspaceId=ws-A"');
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

  // R26 pages L6: both new-tab links say so, with the shared visible hint, in their own text.
  it("the review link and Print card show that they open in a new tab", () => {
    const html = render({ status: "ready", url: LINK });
    // One hint, from ExternalLink (external-link.tsx).
    expect(html).toContain(
      // LL2 lead review: the hint doesn't inherit the URL's break-all, so it breaks only between words.
      `<a href="${LINK}" class="break-all text-sm text-primary underline-offset-4 hover:underline" target="_blank" rel="noopener noreferrer">${LINK} <span class="text-xs font-normal print:hidden break-normal">(opens in a new tab)</span></a>`,
    );
    expect(html).toMatch(/<a [^>]*href="\/reviews\/print-card\?workspaceId=ws-A"[^>]*>Print card <span class="text-xs font-normal print:hidden">\(opens in a new tab\)<\/span><\/a>/);
    expect(html).toMatch(/<a [^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Print card/);
  });

  it("shows a placeholder while loading", () => {
    const html = render({ status: "loading" });

    expect(html).toContain("Get more reviews");
    expect(html).not.toContain("<svg");
  });
});

// LL2 second review: in the iOS installed app a new tab opens the browser,
// signed out, and the print card sends it to Log in. Print card follows the
// sign-in link's rule: the same view in the installed app, a new tab otherwise.
describe("Print card and the installed app", () => {
  it("in a browser tab: a new tab, with the visible hint", () => {
    const html = renderToStaticMarkup(createElement(PrintCardLinkView, { installed: false, workspaceId: "ws-A" }));
    expect(html).toMatch(/<a href="\/reviews\/print-card\?workspaceId=ws-A" [^>]*target="_blank" rel="noopener noreferrer">Print card <span[^>]*>\(opens in a new tab\)<\/span><\/a>/);
  });

  it("in the installed app: the same view, and no new-tab hint", () => {
    const html = renderToStaticMarkup(createElement(PrintCardLinkView, { installed: true, workspaceId: "ws-A" }));
    expect(html).toMatch(/<a [^>]*href="\/reviews\/print-card\?workspaceId=ws-A">Print card<\/a>/);
    expect(html).not.toContain("target=");
    expect(html).not.toContain("new tab");
  });

  it("the panel decides with the shared installed-app hook", () => {
    const source = readFileSync(path.join(__dirname, "review-link-panel.tsx"), "utf8");
    expect(source).toContain("<PrintCardLinkView installed={useInstalledApp()} workspaceId={workspaceId} />");
    expect(source).toContain("<PrintCardLink workspaceId={workspaceId} />");
  });
});

// R27 security-billing L2: the card prints the workspace this page was drawn
// for (print-card/page.tsx takes ?workspaceId= and refuses another).
describe("Print card names the page's workspace", () => {
  it("encodes the id into the link", () => {
    const html = renderToStaticMarkup(createElement(PrintCardLinkView, { installed: true, workspaceId: "ws 1&x" }));
    expect(html).toContain('href="/reviews/print-card?workspaceId=ws%201%26x"');
  });

  it("names it in both views and never the bare path", () => {
    expect(render({ status: "ready", url: LINK }, "ws-B")).toContain('href="/reviews/print-card?workspaceId=ws-B"');
    const source = readFileSync(path.join(__dirname, "review-link-panel.tsx"), "utf8");
    expect(source).not.toContain('href="/reviews/print-card"');
  });
});

// R27 lead's second review: in a stale tab the panel showed the other client's
// review link. It asks with the page's workspace; a 409 shows the notice instead.
describe("the review link and the page's workspace", () => {
  const LOAD_FAILED = "Couldn't load your review link. Reload this page to try again.";

  it("asks with the page's workspaceId", () => {
    const source = readFileSync(path.join(__dirname, "review-link-panel.tsx"), "utf8");
    expect(source).toContain('fetch(withWorkspaceId("/api/reviews/link", workspaceId))');
    expect(source).toContain("setState(reviewLinkStateFrom(response.ok, body));");
  });

  it("reads each answer as today, and a 409 WORKSPACE_CHANGED as the workspace notice", () => {
    expect(reviewLinkStateFrom(true, { url: LINK })).toEqual({ status: "ready", url: LINK });
    expect(reviewLinkStateFrom(true, { url: null, reason: "Connect first." })).toEqual({ status: "none", reason: "Connect first." });
    expect(reviewLinkStateFrom(true, { url: null, reason: "Sign in.", signIn: true })).toEqual({ status: "none", reason: "Sign in.", signIn: true });
    expect(reviewLinkStateFrom(false, null)).toEqual({ status: "none", reason: LOAD_FAILED });
    expect(reviewLinkStateFrom(false, { code: "WORKSPACE_CHANGED", reason: "x" })).toEqual({ status: "workspace_changed" });
  });

  it("shows the notice with Reload, and no link", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLinkPanelView, { state: { status: "workspace_changed" }, workspaceId: "ws-A", isMember: false }),
    );
    expect(html).toContain(WORKSPACE_CHANGED_RELOAD_MESSAGE.replace("'", "&#x27;"));
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).not.toContain("print-card");
  });

  it("with the page's notice above: the sentence only, one Reload per page", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLinkPanelView, {
        state: { status: "workspace_changed" },
        workspaceId: "ws-A",
        isMember: false,
        workspaceNoticeShownAbove: true,
      }),
    );
    expect(html).toContain(WORKSPACE_CHANGED_RELOAD_MESSAGE.replace("'", "&#x27;"));
    expect(html).not.toContain(">Reload</button>");
  });
});
