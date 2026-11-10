import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveReviewLinkMock, viewPropsMock } = vi.hoisted(() => ({
  findActiveReviewLinkMock: vi.fn(),
  viewPropsMock: vi.fn(),
}));

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
    expect(html).toContain("Surf &amp; Co: upcoming posts");
    expect(html).toContain("These go out at the time shown unless you ask for a change.");
    expect(viewPropsMock).toHaveBeenCalledWith({ token: TOKEN });
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
  });
});
