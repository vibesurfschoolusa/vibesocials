import { beforeEach, describe, expect, it, vi } from "vitest";

// F7 (R1 M4, M5): GET /api/reviews loads every page and never shows Google's
// own error text. Google itself is stubbed out (server/googleReviews.ts).
const { getWorkspaceContextMock, findFirstMock, fetchAllReviewsMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  fetchAllReviewsMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: findFirstMock } } }));
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  fetchAllReviews: fetchAllReviewsMock,
  refreshAccessToken: vi.fn(),
}));

import { GOOGLE_REFUSED_MESSAGE } from "@/server/googleReviews";

import { GET } from "./route";

const get = () => GET(new Request("http://localhost/api/reviews?location=accounts%2F1%2Flocations%2F2"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "member" });
  findFirstMock.mockResolvedValue({
    id: "c1",
    accessToken: "tok",
    expiresAt: null,
    metadata: { locationName: "accounts/1/locations/2" },
  });
});

describe("GET /api/reviews", () => {
  it("returns every review read and whether the list was cut short", async () => {
    fetchAllReviewsMock.mockResolvedValue({ reviews: [{ reviewId: "a" }, { reviewId: "b" }], truncated: true });

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reviews: [{ reviewId: "a" }, { reviewId: "b" }],
      truncated: true,
    });
    expect(fetchAllReviewsMock).toHaveBeenCalledWith("tok", "accounts/1/locations/2");
  });

  it("asks for a reconnect when Google refuses", async () => {
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed to fetch Google Business Profile reviews (status 403)"), { status: 403 }),
    );

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  it("gives a plain sentence for anything else, not the error's text", async () => {
    fetchAllReviewsMock.mockRejectedValue(new SyntaxError("Unexpected token < in JSON at position 0"));

    const response = await get();
    const body = (await response.json()) as { error: string };

    expect(body.error).toBe("Couldn't load your Google reviews. Try again in a minute.");
    expect(body.error).not.toContain("JSON");
  });

  it("asks for a reconnect when the connection holds no token", async () => {
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: null, expiresAt: null, metadata: {} });

    const body = (await (await get()).json()) as { error: string; reconnect?: boolean };

    expect(body).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });
});
