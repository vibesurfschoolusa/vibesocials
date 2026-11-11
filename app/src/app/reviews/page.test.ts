import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceContextMock, findFirstMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: findFirstMock } } }));
vi.mock("./reviews-view", () => ({ ReviewsView: () => null }));

import ReviewsPage from "./page";

type Element = { props: { savedLocation: string | null } };

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findFirstMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue({ user: { id: "u1" }, workspace: { id: "ws-1" }, role: "owner" });
});

// Go-live check 2026-11-11: the view opens with the location Settings holds.
describe("ReviewsPage", () => {
  it("passes the workspace's saved Google location, read for this workspace only", async () => {
    findFirstMock.mockResolvedValue({ metadata: { locationName: "accounts/1/locations/2", accessToken: "x" } });
    const element = (await ReviewsPage()) as Element;
    expect(element.props.savedLocation).toBe("accounts/1/locations/2");
    const query = findFirstMock.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: "ws-1", platform: "google_business_profile" });
    expect(query.select).toEqual({ metadata: true });
  });

  it("passes null without a connection or a saved location", async () => {
    findFirstMock.mockResolvedValue(null);
    expect(((await ReviewsPage()) as Element).props.savedLocation).toBeNull();
    findFirstMock.mockResolvedValue({ metadata: {} });
    expect(((await ReviewsPage()) as Element).props.savedLocation).toBeNull();
  });

  it("still sends a signed-out visitor to login", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    await expect(ReviewsPage()).rejects.toThrow("REDIRECT /login?callbackUrl=%2Freviews");
  });
});
