import { beforeEach, describe, expect, it, vi } from "vitest";

// F7 (R1-security L5): the reply route sent body.reviewName to Google unchecked.
const { getWorkspaceContextMock, findFirstMock, replyToReviewMock, listGbpLocationsMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  replyToReviewMock: vi.fn(),
  listGbpLocationsMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/workspaceStatus", () => ({ accessBlockResponse: () => null }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: findFirstMock } } }));
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  replyToReview: replyToReviewMock,
  listGbpLocations: listGbpLocationsMock,
  refreshAccessToken: vi.fn(),
}));

import { GOOGLE_REFUSED_MESSAGE } from "@/server/googleReviews";

import { POST } from "./route";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/reviews/r1/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

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
  replyToReviewMock.mockResolvedValue({ comment: "Thanks", updateTime: "2026-11-14T00:00:00Z" });
  listGbpLocationsMock.mockResolvedValue({
    locations: [
      { name: "accounts/1/locations/2", locationName: "Main", title: "Main" },
      { name: "accounts/1/locations/5", locationName: "Beach", title: "Beach" },
    ],
    complete: true,
  });
});

describe("POST /api/reviews/[reviewId]/reply", () => {
  it("posts a reply to a review's resource name", async () => {
    const response = await post({ comment: " Thanks ", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(200);
    expect(replyToReviewMock).toHaveBeenCalledWith("tok", "accounts/1/locations/2/reviews/r1", "Thanks");
  });

  it.each([
    "accounts/1/locations/2/reviews/r1/../../../../v1/other",
    "accounts/1/locations/2",
    "https://example.test/x",
  ])("answers 404 and sends nothing for %j", async (reviewName) => {
    const response = await post({ comment: "Thanks", reviewName });

    expect(response.status).toBe(404);
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when Google refuses the reply", async () => {
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  it("gives a plain sentence for any other failure", async () => {
    replyToReviewMock.mockRejectedValue(new TypeError("fetch failed"));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
  });

  // Coordinator (b): the review's location must be one this connection's Google account lists.
  it("replies on any location the account lists, not only the one saved in Settings", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/5/reviews/r9" });

    expect(response.status).toBe(200);
    expect(listGbpLocationsMock).toHaveBeenCalledWith("tok");
    expect(replyToReviewMock).toHaveBeenCalledWith("tok", "accounts/1/locations/5/reviews/r9", "Thanks");
  });

  it("works when Settings saved a store code instead of a resource name", async () => {
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: "tok", expiresAt: null, metadata: { locationName: "FTL-01" } });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(200);
    expect(replyToReviewMock).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a location the account does not list, and sends no reply", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/7/locations/99/reviews/r1" });

    expect(response.status).toBe(404);
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("does not list locations for a malformed name", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2" });

    expect(response.status).toBe(404);
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
  });

  it("gives a plain error and sends no reply when the listing fails", async () => {
    listGbpLocationsMock.mockRejectedValue(Object.assign(new Error("Failed (status 503)"), { status: 503 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("gives a plain error, not a 404, when an account's locations could not be read", async () => {
    listGbpLocationsMock.mockResolvedValue({ locations: [], complete: false });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when Google refuses the listing", async () => {
    listGbpLocationsMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });
});
