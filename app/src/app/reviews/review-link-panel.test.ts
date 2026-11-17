import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

import { qrSvg } from "@/lib/qrSvg";

import { WORKSPACE_CHANGED_RELOAD_MESSAGE } from "@/components/reviews/workspace-changed";

import {
  PrintCardLinkView,
  ReviewLinkPanelView,
  reviewLinkLocationLine,
  reviewLinkStateFrom,
  reviewRequestMessage,
  shownLinkLocation,
} from "./review-link-panel";

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

// R32 client-journey L4: the link is the saved location's, whichever location
// the list above shows. The panel names it; only when the list shows another
// location does it add that the link is not for that one.
describe("the review link names its location", () => {
  const A = "accounts/1/locations/2";
  const B = "accounts/1/locations/5";

  it("reads the route's saved location with the link", () => {
    expect(reviewLinkStateFrom(true, { url: LINK, location: "Branch A", locationId: A })).toEqual({
      status: "ready",
      url: LINK,
      location: { id: A, title: "Branch A" },
    });
    // R33 client-journey L1: the id alone still says which location the link is for.
    expect(reviewLinkStateFrom(true, { url: LINK, location: "", locationId: A })).toEqual({
      status: "ready",
      url: LINK,
      location: { id: A, title: null },
    });
    expect(reviewLinkStateFrom(true, { url: LINK, location: 7, locationId: A })).toEqual({
      status: "ready",
      url: LINK,
      location: { id: A, title: null },
    });
    expect(reviewLinkStateFrom(true, { url: LINK, locationId: A })).toEqual({
      status: "ready",
      url: LINK,
      location: { id: A, title: null },
    });
    expect(reviewLinkStateFrom(true, { url: LINK, location: "Branch A" })).toEqual({ status: "ready", url: LINK });
  });

  it("the shown location is the saved one: the label names it, nothing more", () => {
    const html = renderShown({ id: A, title: "Branch A" });
    expect(html).toContain("Your Google review link for Branch A");
    expect(html).not.toContain("not for");
    expect(renderShown(null)).toContain("Your Google review link for Branch A");
    expect(renderShown(null)).not.toContain("not for");
  });

  it("another location is shown: the link is said to be the saved one's, not the shown one's", () => {
    const html = renderShown({ id: B, title: "Branch B" });
    expect(html).toContain("Your Google review link for Branch A");
    expect(html).toContain("This link is for Branch A, the location saved in Settings, not for Branch B.");
  });

  it("a saved store code matches the shown location by its title", () => {
    expect(reviewLinkLocationLine({ id: "FTL-01", title: "Branch A" }, { id: A, title: "Branch A" })).toBeNull();
    expect(reviewLinkLocationLine({ id: "FTL-01", title: "Branch A" }, { id: B, title: "Branch B" })).toBe(
      "This link is for Branch A, the location saved in Settings, not for Branch B.",
    );
    expect(reviewLinkLocationLine({ id: A, title: "Branch A" }, { id: A, title: "Renamed" })).toBeNull();
  });

  it("without a saved title, the label stays as it was", () => {
    const html = render({ status: "ready", url: LINK });
    expect(html).toContain("Your Google review link<");
    expect(html).not.toContain("the location saved in Settings");
  });

  it("Reviews passes the shown location's id and title to the panel", () => {
    const view = readFileSync(path.join(__dirname, "reviews-view.tsx"), "utf8");
    const panel = view.slice(view.indexOf("<ReviewLinkPanel"), view.indexOf("/>", view.indexOf("<ReviewLinkPanel")));
    expect(panel).toContain("shownLocation={shownLinkLocation(locations, selectedLocation)}");
    expect(shownLinkLocation([{ name: B, locationName: "locations/5", title: "Branch B" }], B)).toEqual({
      shown: { id: B, title: "Branch B" },
      listed: [{ name: B, title: "Branch B" }],
    });
    expect(shownLinkLocation([{ name: B, locationName: "locations/5", title: "Branch B" }], A).shown).toBeNull();
    expect(shownLinkLocation([], null)).toEqual({ shown: null, listed: [] });
    // Only what the panel reads is passed on.
    expect(shownLinkLocation([{ name: B, locationName: "locations/5", title: "Branch B", storeCode: "FTL-01", address: "1 Beach Rd" }], B).listed).toEqual([
      { name: B, title: "Branch B", storeCode: "FTL-01" },
    ]);
  });
});

// R33 client-journey L1: the saved location without a saved title (an Advanced
// save, or one before 9 Nov) is named from the listed locations.
describe("the review link names its location from the list", () => {
  const A = "accounts/1/locations/2";
  const B = "accounts/1/locations/5";
  const listed = [
    { name: A, locationName: "locations/2", title: "Branch A", storeCode: "FTL-01" },
    { name: B, locationName: "locations/5", title: "Branch B", storeCode: "SHARED" },
    { name: "accounts/1/locations/7", locationName: "locations/7", title: "Branch C", storeCode: "SHARED" },
  ];
  const view = (location: { id: string; title: string | null }, shown: string | null) =>
    renderToStaticMarkup(
      createElement(ReviewLinkPanelView, {
        state: { status: "ready", url: LINK, location },
        workspaceId: "ws-A",
        isMember: false,
        shownLocation: shownLinkLocation(listed, shown),
      }),
    );

  it("a saved resource name takes its listed title", () => {
    const html = view({ id: A, title: null }, A);
    expect(html).toContain("Your Google review link for Branch A");
    expect(html).not.toContain("not for");
  });

  it("a store code only one location has takes that location's title, and is compared by it", () => {
    expect(view({ id: "FTL-01", title: null }, A)).toContain("Your Google review link for Branch A");
    expect(view({ id: "FTL-01", title: null }, A)).not.toContain("not for");
    expect(view({ id: "FTL-01", title: null }, B)).toContain(
      "This link is for Branch A, the location saved in Settings, not for Branch B.",
    );
  });

  it("the listed title wins over an old saved one", () => {
    expect(view({ id: A, title: "Old name" }, A)).toContain("Your Google review link for Branch A");
  });

  it("no match (a store code two locations share, or not listed): the location saved in Settings", () => {
    const shared = view({ id: "SHARED", title: null }, B);
    expect(shared).toContain("Your Google review link for the location saved in Settings");
    expect(shared).toContain("This link is for the location saved in Settings, not for Branch B.");
    const missing = view({ id: "accounts/1/locations/99", title: null }, A);
    expect(missing).toContain("Your Google review link for the location saved in Settings");
    expect(missing).toContain("This link is for the location saved in Settings, not for Branch A.");
  });

  it("no match and nothing shown: the label only", () => {
    const html = view({ id: "accounts/1/locations/99", title: null }, null);
    expect(html).toContain("Your Google review link for the location saved in Settings");
    expect(html).not.toContain("not for");
  });
});

// R34 client-journey L2: two branches with the same name read as the picker
// labels them (locationLabels: the address), in the heading and the line.
describe("the review link names same-name branches as the picker does", () => {
  const MAIN = "accounts/1/locations/2";
  const BEACH = "accounts/1/locations/5";
  const locations = [
    { name: MAIN, locationName: "locations/2", title: "Joe's Pizza", address: "1 Main St" },
    { name: BEACH, locationName: "locations/5", title: "Joe's Pizza", address: "2 Beach Rd" },
  ];

  it("both the shown and the listed entries carry the picker's labels", () => {
    expect(shownLinkLocation(locations, BEACH)).toEqual({
      shown: { id: BEACH, title: "Joe's Pizza (2 Beach Rd)" },
      listed: [
        { name: MAIN, title: "Joe's Pizza (1 Main St)" },
        { name: BEACH, title: "Joe's Pizza (2 Beach Rd)" },
      ],
    });
  });

  it("the heading and the not-for line tell the two apart", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLinkPanelView, {
        state: { status: "ready", url: LINK, location: { id: MAIN, title: "Joe's Pizza" } },
        workspaceId: "ws-A",
        isMember: false,
        shownLocation: shownLinkLocation(locations, BEACH),
      }),
    );
    expect(html).toContain("Your Google review link for Joe&#x27;s Pizza (1 Main St)");
    expect(html).toContain(
      "This link is for Joe&#x27;s Pizza (1 Main St), the location saved in Settings, not for Joe&#x27;s Pizza (2 Beach Rd).",
    );
  });
});

function renderShown(shown: { id: string; title: string } | null): string {
  return renderToStaticMarkup(
    createElement(ReviewLinkPanelView, {
      state: { status: "ready", url: LINK, location: { id: "accounts/1/locations/2", title: "Branch A" } },
      workspaceId: "ws-A",
      isMember: false,
      shownLocation: { shown, listed: [] },
    }),
  );
}
