import { beforeEach, describe, expect, it, vi } from "vitest";

// F7 (R1-security L5): the reply route sent body.reviewName to Google unchecked.
const { getWorkspaceContextMock, findFirstMock, replyToReviewMock, listGbpLocationsMock, checkRateLimitMock, flagRejectedTokenMock } =
  vi.hoisted(() => ({
    getWorkspaceContextMock: vi.fn(),
    findFirstMock: vi.fn(),
    replyToReviewMock: vi.fn(),
    listGbpLocationsMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    flagRejectedTokenMock: vi.fn(),
  }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: flagRejectedTokenMock,
}));
// The one paged listing the Reviews page and the Settings picker share (R25 M1).
vi.mock("@/app/api/connections/google_business_profile/gbpLocations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/connections/google_business_profile/gbpLocations")>()),
  listGbpLocationsWithToken: listGbpLocationsMock,
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/workspaceStatus", () => ({ accessBlockResponse: () => null }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: findFirstMock } } }));
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  replyToReview: replyToReviewMock,
  refreshAccessToken: vi.fn(),
}));

import {
  GOOGLE_REFUSED_MEMBER_MESSAGE,
  GOOGLE_REFUSED_MESSAGE,
  MEMBER_OTHER_LOCATION_MESSAGE,
  refreshAccessToken,
} from "@/server/googleReviews";

import { POST } from "./route";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/reviews/r1/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // R27 security-billing L1: the page sends the workspace it was rendered for.
      body: JSON.stringify({ workspaceId: "ws-1", ...body }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getWorkspaceContextMock.mockResolvedValue({ user: { id: "u1" }, workspace: { id: "ws-1" }, role: "member" });
  findFirstMock.mockResolvedValue({
    id: "c1",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: null,
    metadata: { locationName: "accounts/1/locations/2" },
  });
  replyToReviewMock.mockResolvedValue({ comment: "Thanks", updateTime: "2026-11-14T00:00:00Z" });
  listGbpLocationsMock.mockResolvedValue(listing([listed("accounts/1/locations/2", "FTL-01"), listed("accounts/1/locations/5")]));
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  flagRejectedTokenMock.mockResolvedValue("flagged");
});

const OWNER = { user: { id: "u1" }, workspace: { id: "ws-1" }, role: "owner" };

function listed(resourceName: string, storeCode: string | null = null) {
  return { resourceName, title: "Shop", storeCode, address: null, accountName: "A" };
}

function listing(locations: ReturnType<typeof listed>[], complete = true) {
  return {
    ok: true,
    locations,
    complete,
    unread: { access: false, failed: !complete },
    refusedOnly: false,
  };
}

describe("POST /api/reviews/[reviewId]/reply", () => {
  it("posts a reply to a review's resource name", async () => {
    const response = await post({ comment: " Thanks ", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(200);
    expect(replyToReviewMock).toHaveBeenCalledWith("tok", "accounts/1/locations/2/reviews/r1", "Thanks");
  });

  // R27 security-billing L1: a tab rendered for another workspace never posts
  // through the cookie's connection.
  it("refuses a workspaceId that is not the active workspace: 409, no connection read, nothing sent to Google", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1", workspaceId: "ws-other" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED", error: expect.any(String) });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("refuses a request without the page's workspaceId (400 MISSING_WORKSPACE_ID), nothing sent", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1", workspaceId: undefined });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "MISSING_WORKSPACE_ID" });
    expect(replyToReviewMock).not.toHaveBeenCalled();
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

  // R25 platform-clients L2: an API 401 flags the row, so the card shows Reconnect.
  it("a 401 on the reply flags the row and reads Reconnect, with the in-place sign-in", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true, code: "RECONNECT_REQUIRED" });
    expect(flagRejectedTokenMock).toHaveBeenCalledWith(
      { id: "c1", accessToken: "tok", refreshToken: "ref" },
      "GOOGLE_API_TOKEN_REJECTED",
    );
  });

  // R25 pages L5: a review deleted on Google never takes a reply.
  it("a 404 on the reply says the review is gone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    replyToReviewMock.mockRejectedValue(
      Object.assign(new Error("Failed (status 404)"), { status: 404, code: "GBP_REVIEWS_REPLY_FAILED" }),
    );

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: "This review is no longer on Google. Reload the page.", code: "GBP_REVIEW_GONE" });
  });

  // R25 lead review: an access refusal and a stale store code can't work on a
  // retry either; their status and text stay, with the kind's code.
  it("an access refusal and a stale store code carry their codes, with status and text as before", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 403)"), { status: 403, googleReasons: [] }));
    let response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("GBP_ACCESS_REFUSED");

    listGbpLocationsMock.mockResolvedValue({ ok: false, kind: "chooseAgain" });
    response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("GBP_CHOOSE_LOCATION_AGAIN");
  });

  // R25 security-billing L1: replies are limited per person, 20 every 5 minutes.
  it("over the limit: 429, and Google is not asked", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith({ userId: "u1", route: "reviews/reply", limit: 20, windowMs: 300_000 });
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  // R25 client-journey M1: the check uses the one paged listing, with the token as sent.
  it("checks the location against the shared paged listing", async () => {
    await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(listGbpLocationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", accessToken: "tok", refreshToken: "ref" }),
      "POST /api/reviews/[reviewId]/reply",
    );
  });

  it("gives a plain sentence for any other failure", async () => {
    replyToReviewMock.mockRejectedValue(new SyntaxError("Unexpected token < in JSON"));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
  });

  // JJ3 lead review: no answer from Google is "try later" on every Google surface.
  it("no answer from Google says to try later", async () => {
    replyToReviewMock.mockRejectedValue(new TypeError("fetch failed"));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: "Google Business Profile isn't answering for Vibe Socials right now. Try again later." });
  });

  // Coordinator (b): the review's location must be one this connection's Google account lists.
  it("an owner replies on any location the account lists, not only the one saved in Settings", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/5/reviews/r9" });

    expect(response.status).toBe(200);
    expect(replyToReviewMock).toHaveBeenCalledWith("tok", "accounts/1/locations/5/reviews/r9", "Thanks");
  });

  // R25 client-journey L3: a member answers only the workspace's own saved location.
  it("a member replying on another listed location is refused, and nothing is sent", async () => {
    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/5/reviews/r9" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: MEMBER_OTHER_LOCATION_MESSAGE });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("the saved location on Google's second page is found and answered", async () => {
    listGbpLocationsMock.mockResolvedValue(
      listing([...Array.from({ length: 100 }, (_, i) => listed(`accounts/1/locations/${100 + i}`)), listed("accounts/1/locations/2")]),
    );

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(200);
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
    listGbpLocationsMock.mockResolvedValue({ ok: false, kind: "tryLater" });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Google Business Profile isn't answering for Vibe Socials right now. Try again later." });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("gives a plain error, not a 404, when an account's locations could not be read", async () => {
    listGbpLocationsMock.mockResolvedValue(listing([listed("accounts/1/locations/5")], false));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Couldn't post your reply. Try again in a minute." });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });

  it("says Reconnect when Google refused the token while listing", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    listGbpLocationsMock.mockResolvedValue({ ok: false, kind: "reconnect" });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true, code: "RECONNECT_REQUIRED" });
    expect(replyToReviewMock).not.toHaveBeenCalled();
  });
});

// R12 L1: a member may reply, but only an owner can reconnect.
describe("POST /api/reviews/[reviewId]/reply for a member", () => {
  it("Google refuses the token: who can reconnect, no Settings link", async () => {
    replyToReviewMock.mockRejectedValue(Object.assign(new Error("Failed (status 401)"), { status: 401 }));

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MEMBER_MESSAGE, code: "RECONNECT_REQUIRED" });
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
    expect(listGbpLocationsMock.mock.calls[0][0].accessToken).toBe("fresh");
  });

  it("leaves a token with 10 minutes left alone", async () => {
    expiringIn(10 * MINUTE);

    await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(listGbpLocationsMock.mock.calls[0][0].accessToken).toBe("tok");
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
    expect(listGbpLocationsMock.mock.calls[0][0].accessToken).toBe("tok");
  });

  it("a refresh Google refuses after expiry keeps today's reconnect text", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
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
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true, code: "RECONNECT_REQUIRED" });
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
  });
});

// Lead review (R23): a connection Google has revoked (flagged needsReconnect)
// gets the reconnect text at once, as the link route does, and Google is not asked.
describe("POST /api/reviews/[reviewId]/reply for a connection flagged for reconnect", () => {
  it("answers with the reconnect text and asks Google nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      needsReconnect: true,
      metadata: { locationName: "accounts/1/locations/2" },
    });

    const response = await post({ comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/r1" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true, code: "RECONNECT_REQUIRED" });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(listGbpLocationsMock).not.toHaveBeenCalled();
  });
});

// R26 platform-clients L1: a 401 on a token that ran out on the way (the early
// refresh had failed) is refreshed once and the reply sent once more.
describe("POST /api/reviews/[reviewId]/reply and a 401 on a token that ran out on the way", () => {
  it("refreshes once and replies with the new token: nothing flagged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      findFirstMock.mockResolvedValue({
        id: "c1",
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: new Date(Date.now() + 60 * 1000),
        metadata: { locationName: "accounts/1/locations/2" },
      });
      vi.mocked(refreshAccessToken)
        .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "CONNECTION_REFRESH_BUSY" }))
        .mockResolvedValueOnce({ id: "c1", accessToken: "fresh", refreshToken: "ref", expiresAt: new Date(Date.now() + 3_600_000) } as never);
      replyToReviewMock.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 2 * 60 * 1000);
        throw Object.assign(new Error("401"), { status: 401, code: "GBP_REVIEWS_REPLY_FAILED" });
      });

      const response = await post({ comment: "Thanks!", reviewName: "accounts/1/locations/2/reviews/r1" });

      expect(response.status).toBe(200);
      expect(replyToReviewMock.mock.calls.map(([token]) => token)).toEqual(["tok", "fresh"]);
      expect(flagRejectedTokenMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
