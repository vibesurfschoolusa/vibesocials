import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  findFirst: vi.fn(),
  savedNewReviewUri: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
}));

vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: h.findFirst } } }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("@/server/googleReviews", () => ({ savedNewReviewUri: h.savedNewReviewUri }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import ReviewPrintCardPage, { metadata } from "./page";

const WRONG_WORKSPACE = "This page was opened for another workspace. Go back and open Print card again.";

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await ReviewPrintCardPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getWorkspaceContext.mockResolvedValue({ workspace: { id: "ws-1", name: "Surf Co" }, role: "member" });
  h.findFirst.mockResolvedValue({ metadata: { locationTitle: "Surf Co Dania" } });
  h.savedNewReviewUri.mockReturnValue("https://g.page/r/abc/review");
});

// R5 pages L11.
describe("print card page", () => {
  it("names the tab", () => {
    expect(metadata.title).toBe("Review card | Vibe Socials");
  });
});

// R27 security-billing L2: the card is the workspace the Reviews page was
// rendered for, never the cookie's alone.
describe("print card page: the page's workspace", () => {
  it("with the active workspace's id: prints that workspace's card", async () => {
    const html = await render({ workspaceId: "ws-1" });

    expect(html).toContain("Surf Co Dania");
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) }));
  });

  it("with another workspace's id: a plain page that says so, and no card or connection read", async () => {
    const html = await render({ workspaceId: "ws-other" });

    expect(html).toContain(WRONG_WORKSPACE);
    expect(html).toContain("<h1");
    expect(html).not.toContain("Surf Co Dania");
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it("without an id (an old link or a bookmark): the active workspace's card, as before", async () => {
    expect(await render()).toContain("Surf Co Dania");
  });

  it("signed out: sign-in comes back to the same card, the id kept", async () => {
    h.getWorkspaceContext.mockResolvedValue(null);

    await expect(render({ workspaceId: "ws-1" })).rejects.toMatchObject({
      url: `/login?callbackUrl=${encodeURIComponent("/reviews/print-card?workspaceId=ws-1")}`,
    });
  });
});
