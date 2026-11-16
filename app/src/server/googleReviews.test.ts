import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, resolveMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), resolveMock: vi.fn() }));

vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fetchWithTimeout")>()),
  fetchWithTimeout: fetchMock,
}));
vi.mock("./platforms/gbpLocation", () => ({ resolveGbpLocationName: resolveMock }));
vi.mock("./platforms/connectionRefresh", () => ({ refreshConnectionToken: vi.fn() }));
vi.mock("./platforms/googleTokens", () => ({ refreshGoogleToken: vi.fn() }));

import {
  GOOGLE_REFUSED_MEMBER_MESSAGE,
  GOOGLE_REFUSED_MESSAGE,
  REVIEWS_SHOWN_MAX,
  REVIEWS_UNAVAILABLE_MESSAGE,
  GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE,
  GOOGLE_ACCESS_REFUSED_MESSAGE,
  GOOGLE_NOT_ANSWERING_MESSAGE,
  fetchAllReviews,
  fetchNewReviewUri,
  fetchReviews,
  listGbpLocations,
  reviewLinkReason,
  reviewLocationName,
  reviewsErrorBody,
} from "./googleReviews";
import { isTerminalRefreshFailure } from "./platforms/connectionHealth";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  resolveMock.mockImplementation(async (_token: string, name: string) => name);
});

describe("fetchReviews", () => {
  it("asks for Google's default order when no option is given (unchanged)", async () => {
    fetchMock.mockResolvedValue(json({ reviews: [] }));

    await fetchReviews("tok", "accounts/1/locations/2");

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews",
    );
  });

  it("asks for the most recently updated first, a full page, when newest first is wanted", async () => {
    fetchMock.mockResolvedValue(json({ reviews: [] }));

    await fetchReviews("tok", "accounts/1/locations/2", { newestFirst: true });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v4/accounts/1/locations/2/reviews");
    expect(url.searchParams.get("orderBy")).toBe("updateTime desc");
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("bounds the request by the timeout it is given", async () => {
    fetchMock.mockResolvedValue(json({ reviews: [] }));

    await fetchReviews("tok", "accounts/1/locations/2", { newestFirst: true, timeoutMs: 10_000 });

    expect(fetchMock.mock.calls[0][2]).toBe(10_000);
  });
});

// R19 client-journey: Google fills Reviewer.displayName only when the reviewer
// is not anonymous, so a review can come without a name. Every reader (the card,
// the AI draft, the new-review email) gets "A Google user" instead.
describe("reviews from Google: the reviewer's name", () => {
  const withReviewer = (reviewer: unknown) =>
    json({
      reviews: [
        {
          name: "accounts/1/locations/2/reviews/r1",
          ...(reviewer === undefined ? {} : { reviewer }),
          starRating: "FIVE",
          createTime: "2026-11-01T00:00:00Z",
          updateTime: "2026-11-01T00:00:00Z",
        },
      ],
    });

  it("an anonymous reviewer with no name is 'A Google user', on both reads", async () => {
    fetchMock.mockResolvedValueOnce(withReviewer({ isAnonymous: true }));
    const [first] = await fetchReviews("tok", "accounts/1/locations/2");
    expect(first.reviewer).toEqual({ displayName: "A Google user", isAnonymous: true });

    fetchMock.mockResolvedValueOnce(withReviewer({ isAnonymous: true, displayName: "  " }));
    const { reviews } = await fetchAllReviews("tok", "accounts/1/locations/2");
    expect(reviews[0].reviewer.displayName).toBe("A Google user");
  });

  it("a review with no reviewer at all still names one", async () => {
    fetchMock.mockResolvedValueOnce(withReviewer(undefined));
    const [first] = await fetchReviews("tok", "accounts/1/locations/2");
    expect(first.reviewer).toEqual({ displayName: "A Google user", isAnonymous: false });
  });

  it("a real name is kept, trimmed, with the photo", async () => {
    fetchMock.mockResolvedValueOnce(
      withReviewer({ displayName: " Maria Lopez ", isAnonymous: false, profilePhotoUrl: "https://example.com/p.png" }),
    );
    const [first] = await fetchReviews("tok", "accounts/1/locations/2");
    expect(first.reviewer).toEqual({
      displayName: "Maria Lopez",
      isAnonymous: false,
      profilePhotoUrl: "https://example.com/p.png",
    });
  });
});

describe("fetchNewReviewUri", () => {
  it("reads only metadata.newReviewUri of the location", async () => {
    fetchMock.mockResolvedValue(json({ metadata: { newReviewUri: "https://g.page/r/abc/review" } }));

    await expect(fetchNewReviewUri("tok", "accounts/1/locations/22")).resolves.toBe(
      "https://g.page/r/abc/review",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(String(url)).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/locations/22?readMask=metadata.newReviewUri",
    );
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("resolves a store code first", async () => {
    resolveMock.mockResolvedValue("accounts/9/locations/77");
    fetchMock.mockResolvedValue(json({ metadata: { newReviewUri: "https://g.page/r/x/review" } }));

    await fetchNewReviewUri("tok", "FTL-01");

    expect(resolveMock).toHaveBeenCalledWith("tok", "FTL-01");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/locations/77?");
  });

  it("is null when Google gives no link, or a link that is not https", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(fetchNewReviewUri("tok", "accounts/1/locations/22")).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(json({ metadata: { newReviewUri: "javascript:alert(1)" } }));
    await expect(fetchNewReviewUri("tok", "accounts/1/locations/22")).resolves.toBeNull();
  });

  it("throws when Google refuses", async () => {
    fetchMock.mockResolvedValue(json({ error: { status: "PERMISSION_DENIED" } }, 403));

    await expect(fetchNewReviewUri("tok", "accounts/1/locations/22")).rejects.toMatchObject({
      code: "GBP_REVIEW_LINK_FETCH_FAILED",
    });
  });

  // JJ3 lead review: a 403's reasons ride on the error, so the routes can tell
  // "this account doesn't manage the location" from "the API is off on our side".
  it("a 403 carries Google's reasons (errors[] and ErrorInfo details[])", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "accessNotConfigured" }],
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
          },
        },
        403,
      ),
    );

    const error = (await fetchNewReviewUri("tok", "accounts/1/locations/22").catch((e: unknown) => e)) as {
      status?: number;
      googleReasons?: string[];
    };

    expect(error.status).toBe(403);
    expect([...(error.googleReasons ?? [])].sort()).toEqual(["accessnotconfigured", "servicedisabled"]);
  });

  it("a 403 with a body that is not JSON carries no reasons", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("<html>nope</html>", { status: 403 }));

    const error = (await fetchNewReviewUri("tok", "accounts/1/locations/22").catch((e: unknown) => e)) as {
      googleReasons?: string[];
    };

    expect(error.googleReasons).toEqual([]);
  });
});

// F7 (R1 M4): the Reviews page read only Google's first page, so older reviews
// waiting for a reply never showed.
describe("fetchAllReviews", () => {
  const review = (n: number) => ({
    name: `accounts/1/locations/2/reviews/r${n}`,
    reviewer: { displayName: `Person ${n}`, isAnonymous: false },
    starRating: "FIVE",
    createTime: "2026-11-01T00:00:00Z",
    updateTime: "2026-11-01T00:00:00Z",
  });
  const page = (from: number, count: number, next?: string) =>
    json({ reviews: Array.from({ length: count }, (_, i) => review(from + i)), ...(next ? { nextPageToken: next } : {}) });

  it("follows nextPageToken until Google has no more", async () => {
    fetchMock
      .mockResolvedValueOnce(page(0, 50, "p2"))
      .mockResolvedValueOnce(page(50, 50, "p3"))
      .mockResolvedValueOnce(page(100, 7));

    const result = await fetchAllReviews("tok", "accounts/1/locations/2");

    expect(result.reviews).toHaveLength(107);
    expect(result.reviews[106].reviewId).toBe("r106");
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0].searchParams.get("pageToken")).toBeNull();
    expect(urls[1].searchParams.get("pageToken")).toBe("p2");
    expect(urls[2].searchParams.get("pageToken")).toBe("p3");
    for (const url of urls) {
      expect(url.pathname).toBe("/v4/accounts/1/locations/2/reviews");
      expect(url.searchParams.get("pageSize")).toBe("50");
      expect(url.searchParams.get("orderBy")).toBe("updateTime desc");
    }
  });

  it("resolves a store code once, not per page", async () => {
    resolveMock.mockResolvedValue("accounts/9/locations/77");
    fetchMock.mockResolvedValueOnce(page(0, 50, "p2")).mockResolvedValueOnce(page(50, 1));

    await fetchAllReviews("tok", "FTL-01");

    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v4/accounts/9/locations/77/reviews?");
  });

  it("stops at the cap and says so", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      const response = page(n, 50, `p${n + 50}`);
      n += 50;
      return response;
    });

    const result = await fetchAllReviews("tok", "accounts/1/locations/2");

    expect(REVIEWS_SHOWN_MAX).toBe(500);
    expect(result.reviews).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("is not truncated when the last page ends exactly at the cap", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      const last = n === 450;
      const response = page(n, 50, last ? undefined : `p${n + 50}`);
      n += 50;
      return response;
    });

    const result = await fetchAllReviews("tok", "accounts/1/locations/2");

    expect(result.reviews).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it("does not loop when Google repeats a page token", async () => {
    fetchMock.mockImplementation(async () => page(0, 1, "same"));

    const result = await fetchAllReviews("tok", "accounts/1/locations/2");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.reviews).toHaveLength(2);
  });

  it("throws, with Google's status, when a page is refused", async () => {
    fetchMock.mockResolvedValueOnce(page(0, 50, "p2")).mockResolvedValueOnce(json({ error: {} }, 403));

    await expect(fetchAllReviews("tok", "accounts/1/locations/2")).rejects.toMatchObject({ status: 403 });
  });
});

// F7 (R1 M5): what the Reviews page shows when something fails.
describe("reviewsErrorBody", () => {
  const coded = (fields: Record<string, unknown>) => Object.assign(new Error("Failed (status 403)"), fields);

  it.each([
    ["a 401 from Google", coded({ status: 401, code: "GBP_REVIEWS_FETCH_FAILED" })],
    ["a connection already flagged for reconnecting", coded({ code: "RECONNECT_REQUIRED" })],
    ["a connection removed meanwhile", coded({ code: "CONNECTION_GONE" })],
    ["a refused token refresh", coded({ status: 400, code: "GOOGLE_TOKEN_REFRESH_FAILED" })],
  ])("asks for a reconnect after %s", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  it("says the reconnect sentence the brief asks for", () => {
    expect(GOOGLE_REFUSED_MESSAGE).toBe(
      "Google refused the request. Reconnect Google Business Profile in Settings.",
    );
  });

  it.each([
    ["a 500 from Google", coded({ status: 500, code: "GBP_REVIEWS_FETCH_FAILED" })],
    ["a 429", coded({ status: 429 })],
    ["a token refresh Google could not answer", coded({ status: 503, code: "GOOGLE_TOKEN_REFRESH_FAILED" })],
    ["a network failure", new TypeError("fetch failed")],
    ["a JSON parse error", new SyntaxError("Unexpected token < in JSON at position 0")],
    ["something that is not an error", "boom"],
  ])("gives the plain fallback for %s, never the raw message", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: "Fallback." });
  });

  // R12 L1: a member may read and reply, but only an owner can reconnect, so a
  // member reads who can, without the flag that makes the page link to Settings.
  it("words a refusal for a member: who can reconnect, no reconnect flag", () => {
    expect(reviewsErrorBody(coded({ status: 401 }), "Fallback.", "member")).toEqual({
      error: GOOGLE_REFUSED_MEMBER_MESSAGE,
    });
    expect(GOOGLE_REFUSED_MEMBER_MESSAGE).toBe(
      "Google refused the request. The workspace owner can reconnect Google Business Profile.",
    );
  });

  it("gives a member the same sentence as an owner where no reconnect is asked", () => {
    expect(reviewsErrorBody(coded({ status: 500 }), "Fallback.", "member")).toEqual({ error: "Fallback." });
    expect(reviewsErrorBody(coded({ code: "GOOGLE_MISSING_OAUTH_CREDENTIALS" }), "Fallback.", "member")).toEqual({
      error: REVIEWS_UNAVAILABLE_MESSAGE,
    });
  });
});

// JJ3 lead review: Google also answers 403 when the connected account no
// longer manages the location, or when the API is off on our side, and
// reconnecting fixes neither. A 403 never asks for a reconnect.
describe("reviewsErrorBody: a 403 from Google", () => {
  const forbidden = (googleReasons?: string[]) =>
    Object.assign(new Error("Failed (status 403)"), { status: 403, code: "GBP_REVIEWS_FETCH_FAILED", googleReasons });

  it("says the sentences plainly", () => {
    expect(GOOGLE_ACCESS_REFUSED_MESSAGE).toBe(
      "Google refused access to this location. Check that the connected Google account still manages it in Google Business Profile, or reconnect with an account that does.",
    );
    expect(GOOGLE_NOT_ANSWERING_MESSAGE).toBe(
      "Google Business Profile isn't answering for Vibe Socials right now. Try again later.",
    );
  });

  it.each([
    ["no reason", undefined],
    ["an empty reason list", []],
    ["forbidden", ["forbidden"]],
    ["PERMISSION_DENIED", ["permissiondenied"]],
  ])("%s: the access sentence, no reconnect flag", (_label, reasons) => {
    expect(reviewsErrorBody(forbidden(reasons), "Fallback.", "owner")).toEqual({ error: GOOGLE_ACCESS_REFUSED_MESSAGE });
  });

  it("a member reads who can check it", () => {
    expect(reviewsErrorBody(forbidden(), "Fallback.", "member")).toEqual({ error: GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE });
    expect(GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE).toBe(
      "Google refused access to this location. The workspace owner can check that the connected Google account still manages it in Google Business Profile.",
    );
  });

  it.each([
    ["SERVICE_DISABLED", ["servicedisabled"]],
    ["accessNotConfigured", ["accessnotconfigured"]],
    ["quotaExceeded", ["quotaexceeded"]],
    ["rateLimitExceeded", ["ratelimitexceeded"]],
    ["RATE_LIMIT_EXCEEDED among others", ["forbidden", "ratelimitexceeded"]],
  ])("%s: the try-later sentence for owner and member, and it is logged", (_label, reasons) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(reviewsErrorBody(forbidden(reasons), "Fallback.", "owner")).toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
    expect(reviewsErrorBody(forbidden(reasons), "Fallback.", "member")).toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("403"), { status: 403, reasons });
  });

  it("a 401 still asks for a reconnect", () => {
    expect(reviewsErrorBody(Object.assign(new Error("x"), { status: 401 }), "Fallback.", "owner")).toEqual({
      error: GOOGLE_REFUSED_MESSAGE,
      reconnect: true,
    });
  });
});

// R12 L1: the "Get more reviews" panel's reasons, for whoever reads them.
describe("reviewLinkReason", () => {
  it("an owner: the step in Settings, Connections, as before", () => {
    expect(reviewLinkReason("not_connected", "owner")).toBe(
      "Connect Google Business Profile in Settings, Connections to get your review link.",
    );
    expect(reviewLinkReason("no_location", "owner")).toBe(
      "Choose your Maps location for Google Business Profile in Settings, Connections to get your review link.",
    );
    expect(reviewLinkReason("needs_reconnect", "owner")).toBe(
      "Reconnect Google Business Profile in Settings, Connections to get your review link.",
    );
    expect(reviewLinkReason("google_has_none", "owner")).toBe(
      "Google has no review link for this location yet. Check that the listing is verified in Google Business Profile, then reload this page.",
    );
  });

  it("a member: who can take the step", () => {
    expect(reviewLinkReason("not_connected", "member")).toBe(
      "The workspace owner can connect Google Business Profile; then the review link shows here.",
    );
    expect(reviewLinkReason("no_location", "member")).toBe(
      "The workspace owner can choose the Maps location for Google Business Profile; then the review link shows here.",
    );
    expect(reviewLinkReason("needs_reconnect", "member")).toBe(
      "The workspace owner can reconnect Google Business Profile; then the review link shows here.",
    );
    expect(reviewLinkReason("google_has_none", "member")).toBe(
      "Google has no review link for this location yet. The workspace owner can check that the listing is verified in Google Business Profile.",
    );
  });
});

// F7 (R1-security L5): the reply goes to the review the name names, so it must name one.
describe("reviewLocationName: the shape", () => {
  it("accepts a review's full resource name", () => {
    expect(reviewLocationName("accounts/1/locations/2/reviews/AbC-9_x")).toBe("accounts/1/locations/2");
  });

  it.each([
    "accounts/1/locations/2",
    "accounts/1/locations/2/reviews/",
    "accounts/1/locations/2/reviews/3/reply",
    "accounts/1/locations/2/reviews/../../../x",
    "accounts/1/locations/../reviews/3",
    "/accounts/1/locations/2/reviews/3",
    "locations/2/reviews/3",
    "accounts/1/locations/2/reviews/3?x=1",
    "accounts/1/locations/2/reviews/3#x",
    "accounts/1/locations/2/reviews/a b",
    "",
  ])("refuses %j", (name) => {
    expect(reviewLocationName(name)).toBeNull();
  });
});

describe("reviewLocationName", () => {
  it("is the location part of a review's resource name", () => {
    expect(reviewLocationName("accounts/1/locations/2/reviews/r1")).toBe("accounts/1/locations/2");
  });

  it("is null for anything that is not a review's resource name", () => {
    expect(reviewLocationName("accounts/1/locations/2")).toBeNull();
    expect(reviewLocationName("accounts/1/locations/2/reviews/../x")).toBeNull();
  });
});

// The listing the Reviews page shows and the reply route checks against.
describe("listGbpLocations", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("lists every account's locations with full resource names, complete when every account answered", async () => {
    global.fetch = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/accounts")
        ? json({ accounts: [{ name: "accounts/1" }] })
        : json({ locations: [{ name: "locations/9", title: "Main Street", storeCode: "MS" }] }),
    ) as unknown as typeof fetch;

    await expect(listGbpLocations("tok")).resolves.toEqual({
      locations: [{ name: "accounts/1/locations/9", locationName: "Main Street", title: "Main Street", storeCode: "MS" }],
      complete: true,
    });
  });

  it("is incomplete when an account's locations could not be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/accounts") ? json({ accounts: [{ name: "accounts/1" }] }) : json({}, 503),
    ) as unknown as typeof fetch;

    await expect(listGbpLocations("tok")).resolves.toEqual({ locations: [], complete: false });
  });

  it("throws with Google's status when the accounts call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async () => json({}, 403)) as unknown as typeof fetch;

    await expect(listGbpLocations("tok")).rejects.toMatchObject({ status: 403 });
  });
});

// Review point 3: a reconnect only when the person's Google grant is the
// problem; a refresh our own app setup broke cannot be fixed by reconnecting.
describe("reviewsErrorBody: token refresh failures", () => {
  const refresh = (status: number, oauthError?: string) =>
    Object.assign(new Error(`Failed to refresh Google access token (status ${status})`), {
      status,
      code: "GOOGLE_TOKEN_REFRESH_FAILED",
      ...(oauthError ? { oauthError } : {}),
    });

  it("asks for a reconnect when Google refused the grant (invalid_grant)", () => {
    expect(reviewsErrorBody(refresh(400, "invalid_grant"), "Fallback.", "owner")).toEqual({
      error: GOOGLE_REFUSED_MESSAGE,
      reconnect: true,
    });
  });

  it("asks for a reconnect when there is no refresh token to use", () => {
    const error = Object.assign(new Error("No refresh token"), { code: "GOOGLE_NO_REFRESH_TOKEN" });
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  // JJ3 lead review: the answer follows the rule that flags the row
  // (connectionHealth.ts isTerminalRefreshFailure), so a flagged row never
  // reads "not available" while Settings shows Reconnect.
  it.each([
    ["unauthorized_client (400)", refresh(400, "unauthorized_client")],
    ["a 401 with no OAuth code", refresh(401)],
    ["invalid_grant with no status", Object.assign(new Error("Failed"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", oauthError: "invalid_grant" })],
  ])("asks for a reconnect for %s, as the row is flagged", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  it.each([
    ["a 503", refresh(503)],
    ["a 429", refresh(429)],
    ["a 403 unauthorized_client (not flagged)", refresh(403, "unauthorized_client")],
  ])("gives the route's own sentence for %s, never a reconnect", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: "Fallback." });
  });

  it.each([
    ["invalid_client (401)", refresh(401, "invalid_client")],
    ["invalid_client (400)", refresh(400, "invalid_client")],
    ["missing OAuth credentials", Object.assign(new Error("Missing"), { code: "GOOGLE_MISSING_OAUTH_CREDENTIALS" })],
  ])("gives the not-available sentence for %s, never a reconnect", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: REVIEWS_UNAVAILABLE_MESSAGE });
    expect(REVIEWS_UNAVAILABLE_MESSAGE).toBe("Google Reviews are not available right now. Try again later.");
  });

  it("asks for a reconnect exactly when the refresh flags the row (isTerminalRefreshFailure)", () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500, 503]) {
      for (const oauthError of [undefined, "invalid_grant", "unauthorized_client", "invalid_client", "invalid_request"]) {
        const body = reviewsErrorBody(refresh(status, oauthError), "Fallback.", "owner");
        expect(body.reconnect === true, `${status} ${oauthError}`).toBe(isTerminalRefreshFailure(status, oauthError));
      }
    }
  });

  it("a 400 whose OAuth code was not passed on still reads as a refused grant (the common case)", () => {
    expect(reviewsErrorBody(refresh(400), "Fallback.", "owner")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });
});
