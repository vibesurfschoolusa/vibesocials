import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveReviewLinkMock, viewPropsMock, findLogoMock } = vi.hoisted(() => ({
  findLogoMock: vi.fn(),
  findActiveReviewLinkMock: vi.fn(),
  viewPropsMock: vi.fn(),
}));

vi.mock("@/lib/clientPageLogo", () => ({ findClientPageLogo: findLogoMock }));
vi.mock("@/server/reviewLink", () => ({ findActiveReviewLink: findActiveReviewLinkMock }));
// The list is a client component; what the page hands it is what matters here.
vi.mock("./review-link-view", () => ({
  ReviewLinkView: (props: Record<string, unknown>) => {
    viewPropsMock(props);
    return createElement("section", null, "list");
  },
}));

import { REVIEW_LINK_INACTIVE_MESSAGE } from "@/lib/reviewLink";

import ReviewLinkPage from "./page";

const TOKEN = "T".repeat(43);

async function render(token = TOKEN): Promise<string> {
  return renderToStaticMarkup(
    (await ReviewLinkPage({ params: Promise.resolve({ token }) })) as ReactElement,
  );
}

beforeEach(() => {
  findActiveReviewLinkMock.mockReset();
  viewPropsMock.mockReset();
  findLogoMock.mockReset();
  findLogoMock.mockResolvedValue(null);
});

describe("the review link page", () => {
  it("shows an unknown and a revoked link identically, with only the sentence", async () => {
    // findActiveReviewLink gives null for both (src/server/reviewLink.test.ts).
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await render("unknown");
    const revoked = await render(TOKEN);

    expect(unknown).toBe(revoked);
    expect(unknown).toContain(REVIEW_LINK_INACTIVE_MESSAGE);
    expect(unknown).not.toContain("<section");
    expect(unknown).not.toContain("Reports");
    expect(viewPropsMock).not.toHaveBeenCalled();
  });

  it("names the workspace, says what happens, and hands the list only the token", async () => {
    findActiveReviewLinkMock.mockResolvedValue({
      id: "link-1",
      workspaceId: "ws-1",
      workspaceName: "Surf & Co",
    });

    const html = await render();

    expect(findActiveReviewLinkMock).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain("Surf &amp; Co");
    expect(html).toMatch(/<h1[^>]*>Upcoming posts<\/h1>/);
    expect(html).toContain("These go out at the time shown unless you ask for a change.");
    expect(viewPropsMock).toHaveBeenCalledWith({ token: TOKEN });
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
  });

  it("links to the link's monthly reports above the list", async () => {
    findActiveReviewLinkMock.mockResolvedValue({ id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" });

    const html = await render();

    expect(html).toMatch(new RegExp(`<a[^>]*href="/v/${TOKEN}/report"[^>]*>Reports</a>`));
    expect(html.indexOf("Reports")).toBeLessThan(html.indexOf("These go out"));
  });
});

// G4 (R2-pages L7): a client reviewing posts can read the Terms and Privacy, as on /u and /c.
describe("the review link page: Terms and Privacy", () => {
  it("links to both below the list", async () => {
    findActiveReviewLinkMock.mockResolvedValue({ id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" });

    const html = await render();

    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
    expect(html.indexOf('href="/privacy"')).toBeGreaterThan(html.indexOf("<section"));
  });

  it("links to both on the inactive-link sentence too", async () => {
    findActiveReviewLinkMock.mockResolvedValue(null);

    const html = await render("unknown");

    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});
