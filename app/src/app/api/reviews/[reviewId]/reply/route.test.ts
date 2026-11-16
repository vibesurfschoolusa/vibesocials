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

import { GOOGLE_REFUSED_MEMBER_MESSAGE, GOOGLE_REFUSED_MESSAGE, refreshAccessToken } from "@/server/googleReviews";

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
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
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
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    listGbpLocationsMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });
});

// R12 L1: a member may reply, but only an owner can reconnect.
describe("POST /api/reviews/[reviewId]/reply for a member", () => {
  it("Google refuses: who can reconnect, no Settings link", async () => {
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MEMBER_MESSAGE });
  });
});

// R17-client-journey addendum L1: Google's ReviewReply.comment "The maximum
// length is 4096 bytes." (lead checked Google's docs, 2026-11-15).
describe("POST /api/reviews/[reviewId]/reply and Google's length limit", () => {
  const reviewName = "accounts/1/locations/2/reviews/r1";
  const TOO_LONG =
    "Your reply is too long for Google. Google allows 4,096 bytes, about 4,000 characters (emoji and accented letters count more). Shorten it and try again.";

  it("sends a reply of exactly 4096 bytes", async () => {
    const comment = "a".repeat(4096);
    const response = await post({ comment, reviewName });

    expect(response.status).toBe(200);
    expect(replyToReviewMock).toHaveBeenCalledWith("tok", reviewName, comment);
  });

  it("refuses 4097 bytes with a plain 400 and sends nothing to Google", async () => {
    const response = await post({ comment: "a".repeat(4097), reviewName });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: TOO_LONG });
    expect(replyToReviewMock).not.toHaveBeenCalled();
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
  });

  it("refuses a reply under 4096 characters but over 4096 bytes", async () => {
    const comment = `${"é".repeat(2000)} ${"😀".repeat(30)}`;
    expect(Array.from(comment).length).toBeLessThan(4096);

    const response = await post({ comment, reviewName });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: TOO_LONG });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("counts the trimmed reply, as sent", async () => {
    const response = await post({ comment: `  ${"a".repeat(4096)}  `, reviewName });

    expect(response.status).toBe(200);
  });

  it("still refuses an empty reply as before", async () => {
    const response = await post({ comment: "   ", reviewName });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Reply comment is required" });
  });

  it("keeps today's message when Google answers 400 for another reason", async () => {
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 400)"), { status: 400 }));

    const response = await post({ comment: "Thanks", reviewName });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
  });
});

// R23 client-journey L1: a Google token in its last 5 minutes is refreshed
// first (googleTokenExpiresSoon), so a long listing never runs past expiry.
describe("POST /api/reviews/[reviewId]/reply and a token about to expire", () => {
  const MINUTE = 60 * 1000;
  const expiringIn = (ms: number) =>
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: new Date(Date.now() + ms),
      metadata: { locationName: "accounts/1/locations/2" },
    });

  it("refreshes a token with 4 minutes left before asking Google", async () => {
    expiringIn(4 * MINUTE);
    vi.mocked(refreshAccessToken).mockResolvedValue({ accessToken: "fresh" } as never);

    await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(listGbpLocationsMock.mock.calls[0][0]).toBe("fresh");
  });

  it("leaves a token with 10 minutes left alone", async () => {
    expiringIn(10 * MINUTE);

    await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(listGbpLocationsMock.mock.calls[0][0]).toBe("tok");
  });

  it("a failed refresh with 4 minutes left serves the request with the stored token", async () => {
    expiringIn(4 * MINUTE);
    vi.mocked(refreshAccessToken).mockRejectedValue(
      Object.assign(new Error("Failed to refresh Google access token (status 503)"), {
        code: "GOOGLE_TOKEN_REFRESH_FAILED",
        status: 503,
      }),
    );

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(200);
    expect(listGbpLocationsMock.mock.calls[0][0]).toBe("tok");
  });

  it("a refresh Google refuses after expiry keeps today's reconnect text", async () => {
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    expiringIn(-MINUTE);
    vi.mocked(refreshAccessToken).mockRejectedValue(
      Object.assign(new Error("Failed to refresh Google access token (status 400)"), {
        code: "GOOGLE_TOKEN_REFRESH_FAILED",
        status: 400,
        oauthError: "invalid_grant",
      }),
    );

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
  });
});
