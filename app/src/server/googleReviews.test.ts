import { beforeEach, describe, expect, it, vi } from "vitest";

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
  GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE,
  GOOGLE_ACCESS_REFUSED_MESSAGE,
  GOOGLE_NOT_ANSWERING_MESSAGE,
  googleAccessRefusedMessage,
  fetchAllReviews,
  fetchNewReviewUri,
  fetchReviews,
  reviewLinkReason,
  reviewLocationName,
  reviewsErrorBody,
  reviewsListedLocation,
  savedLocationIn,
  reviewsKindBody,
  REPLY_FINAL_CODES,
  replyErrorBody,
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

// JJ3 lead review: the Reviews routes word each kind of Google failure
// (server/googleFailure.ts decides the kind), for an owner or a member.
describe("reviewsErrorBody: each kind, worded for the Reviews page", () => {
  const failing = (fields: Record<string, unknown>) => Object.assign(new Error("Google failed"), fields);
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // R25 platform-clients L2: an API 401 and a missing scope flag the row too
  // (flagIfTokenRejected), so they read Reconnect; the owner keeps the in-place sign-in.
  it("reconnect (a flagged row, whose card shows Reconnect): the owner gets the step, the Settings link and the sign-in", () => {
    for (const error of [
      failing({ code: "RECONNECT_REQUIRED" }),
      failing({ code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 400, oauthError: "invalid_grant" }),
      failing({ status: 401 }),
      failing({ status: 403, googleReasons: ["accesstokenscopeinsufficient"] }),
    ]) {
      const owner = reviewsErrorBody(error, "Fallback.", "owner");
      expect(owner).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
      expect(JSON.stringify(owner)).not.toContain("/api/auth");
      expect(reviewsErrorBody(error, "Fallback.", "member")).toEqual({ error: GOOGLE_REFUSED_MEMBER_MESSAGE });
    }
    expect(GOOGLE_REFUSED_MESSAGE).toBe("Google refused the request. Sign in to Google again with the account that manages this listing.");
    expect(GOOGLE_REFUSED_MEMBER_MESSAGE).toBe(
      "Google refused the request. The workspace owner can reconnect Google Business Profile.",
    );
  });

  // R25 platform-clients L3 and pages L5.
  it("chooseAgain: a stale store code; reviewGone: a review deleted on Google", () => {
    const stale = failing({ code: "GBP_STORE_CODE_NOT_UNIQUE" });
    expect(reviewsErrorBody(stale, "Fallback.", "owner")).toEqual({
      error: "The saved store code no longer matches one Google Business Profile location. Choose the location again in Settings.",
      reconnect: true,
    });
    expect(reviewsErrorBody(stale, "Fallback.", "member")).toEqual({
      error: "The saved store code no longer matches one Google Business Profile location. The workspace owner can choose the location again.",
    });
    const gone = failing({ status: 404, code: "GBP_REVIEWS_REPLY_FAILED" });
    expect(reviewsErrorBody(gone, "Fallback.", "member")).toEqual({ error: "This review is no longer on Google. Reload the page." });
  });

  // JJ3 lead review: the Reviews page can pick a location that is not the saved one.
  // R26 client-journey L1: a member has no picker, so theirs names the owner and Settings.
  it("notFound, the saved location: the owner chooses another in Settings; a member reads the owner can", () => {
    const error = failing({ status: 404, code: "GBP_REVIEWS_FETCH_FAILED" });
    expect(reviewsErrorBody(error, "Fallback.", "owner", { location: "saved" })).toEqual({
      error: "This location is no longer in Google Business Profile. Choose another location in Settings (it's also where your Google posts go).",
      reconnect: true,
    });
    expect(reviewsErrorBody(error, "Fallback.", "member", { location: "saved" })).toEqual({
      error: "This location is no longer in Google Business Profile. The workspace owner can choose another location.",
    });
  });

  it("notFound, a location an owner picked on the Reviews page: pick another above; a member never reads it", () => {
    const error = failing({ status: 404, code: "GBP_REVIEWS_FETCH_FAILED" });
    expect(reviewsErrorBody(error, "Fallback.", "owner", { location: "picked" })).toEqual({ error: "This location is no longer in Google Business Profile. Pick another location above." });
    expect(reviewsErrorBody(error, "Fallback.", "member", { location: "picked" })).toEqual({
      error: "This location is no longer in Google Business Profile. The workspace owner can choose another location.",
    });
  });

  // R25 client-journey L1: the in-place sign-in with the account that manages
  // the location keeps the row, its numbers and the location; Switch account
  // (which deletes them) is never named.
  it("access, about a location (list, reply): the in-place sign-in for an owner, the same fact for a member", () => {
    const error = failing({ status: 403, googleReasons: ["forbidden"] });
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({
      error: GOOGLE_ACCESS_REFUSED_MESSAGE,
      reconnect: true,
      signIn: true,
    });
    expect(reviewsErrorBody(error, "Fallback.", "member")).toEqual({ error: GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE });
    expect(GOOGLE_ACCESS_REFUSED_MESSAGE).toBe(
      "Google refused access to this location: the connected Google account may no longer manage it. Sign in to Google again with the account that manages this location.",
    );
    expect(GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE).toBe(
      "Google refused access to this location: the connected Google account may no longer manage it. The workspace owner can sign in to Google again with the account that manages it.",
    );
  });

  it("access, where no location is chosen yet (locations): about the account", () => {
    const error = failing({ status: 403 });
    expect(reviewsErrorBody(error, "Fallback.", "owner", { subject: "account" })).toEqual({
      error:
        "Google refused access to this Business Profile account: the connected Google account may no longer manage your business. Sign in to Google again with the account that manages your business.",
      reconnect: true,
      signIn: true,
    });
    expect(reviewsErrorBody(error, "Fallback.", "member", { subject: "account" })).toEqual({
      error:
        "Google refused access to this Business Profile account: the connected Google account may no longer manage your business. The workspace owner can sign in to Google again with the account that manages it.",
    });
    expect(googleAccessRefusedMessage("location", "owner")).toBe(GOOGLE_ACCESS_REFUSED_MESSAGE);
  });

  it("no answer names Switch account", () => {
    const errors = [
      failing({ status: 401 }),
      failing({ status: 403 }),
      failing({ status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }),
      failing({ code: "GBP_STORE_CODE_NOT_FOUND" }),
      failing({ code: "RECONNECT_REQUIRED" }),
    ];
    for (const error of errors) {
      for (const role of ["owner", "member"] as const) {
        for (const subject of ["location", "account"] as const) {
          expect(reviewsErrorBody(error, "Fallback.", role, { subject }).error).not.toMatch(/switch/i);
        }
      }
    }
  });

  it("tryLater: the same plain sentence for owner and member", () => {
    for (const error of [
      failing({ status: 403, googleReasons: ["servicedisabled"] }),
      failing({ status: 503 }),
      failing({ status: 429 }),
      new TypeError("fetch failed"),
      failing({ code: "GOOGLE_MISSING_OAUTH_CREDENTIALS" }),
      failing({ code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 401, oauthError: "invalid_client" }),
    ]) {
      expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
      expect(reviewsErrorBody(error, "Fallback.", "member")).toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
    }
    expect(GOOGLE_NOT_ANSWERING_MESSAGE).toBe(
      "Google Business Profile isn't answering for Vibe Socials right now. Try again later.",
    );
  });

  it("other: the route's own sentence, never the error's text", () => {
    expect(reviewsErrorBody(new SyntaxError("Unexpected token < in JSON"), "Fallback.", "owner")).toEqual({ error: "Fallback." });
    expect(reviewsErrorBody(failing({ status: 404 }), "Fallback.", "member")).toEqual({ error: "Fallback." });
  });

  it("logs one line per failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reviewsErrorBody(failing({ status: 403 }), "Fallback.", "owner", { where: "GET /api/reviews" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ where: "GET /api/reviews", kind: "access", status: 403 });
  });

  it("asks for a reconnect exactly when a refresh failure flags the row (isTerminalRefreshFailure)", () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500, 503]) {
      for (const oauthError of [undefined, "invalid_grant", "unauthorized_client", "invalid_client", "invalid_request"]) {
        const error = failing({ code: "GOOGLE_TOKEN_REFRESH_FAILED", status, ...(oauthError ? { oauthError } : {}) });
        const body = reviewsErrorBody(error, "Fallback.", "owner");
        expect(body.reconnect === true, `${status} ${oauthError}`).toBe(isTerminalRefreshFailure(status, oauthError));
        expect(body.signIn === true, `${status} ${oauthError}`).toBe(isTerminalRefreshFailure(status, oauthError));
      }
    }
  });
});

// R25 lead review: a reply that can't work however often it is sent says so
// with a code, so the page closes the confirm dialog and keeps the sentence in
// the form. Only try-later (and the route's own fallback) stay retryable.
describe("replyErrorBody", () => {
  it("adds the kind's code to the Reviews answer for the kinds a retry can't change, for owners and members", () => {
    const codes = {
      reconnect: "RECONNECT_REQUIRED",
      access: "GBP_ACCESS_REFUSED",
      notFound: "GBP_LOCATION_GONE",
      chooseAgain: "GBP_CHOOSE_LOCATION_AGAIN",
      reviewGone: "GBP_REVIEW_GONE",
    } as const;
    expect(REPLY_FINAL_CODES).toEqual(codes);
    for (const [kind, code] of Object.entries(codes)) {
      for (const role of ["owner", "member"] as const) {
        const k = kind as keyof typeof codes;
        expect(replyErrorBody(k, "Fallback.", role)).toEqual({ ...reviewsKindBody(k, "Fallback.", role), code });
      }
    }
  });

  it("try-later and anything else: the Reviews answer with no code", () => {
    expect(replyErrorBody("tryLater", "Fallback.", "owner")).toEqual(reviewsKindBody("tryLater", "Fallback.", "owner"));
    expect(replyErrorBody("other", "Fallback.", "owner")).toEqual({ error: "Fallback." });
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
      "Google no longer accepts this connection. Sign in to Google again with the account that manages this listing to get your review link.",
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

// R25 client-journey M1 / L3: the Reviews routes read the shared listing (gbpLocations.ts).
describe("reviewsListedLocation and savedLocationIn", () => {
  const listed = (resourceName: string, storeCode: string | null = null, title: string | null = "Main Street") => ({
    resourceName,
    title,
    storeCode,
  });

  it("words a listed location as the Reviews page reads it", () => {
    expect(reviewsListedLocation(listed("accounts/1/locations/9", "MS"))).toEqual({
      name: "accounts/1/locations/9",
      locationName: "Main Street",
      title: "Main Street",
      storeCode: "MS",
    });
    expect(reviewsListedLocation(listed("accounts/1/locations/9", null, null))).toEqual({
      name: "accounts/1/locations/9",
      locationName: "Unknown Location",
      title: "Unknown Location",
    });
  });

  it("finds the saved location by resource name, or by a store code only one location has", () => {
    const locations = [listed("accounts/1/locations/1", "A"), listed("accounts/1/locations/2", "B"), listed("accounts/2/locations/3", "B")];
    expect(savedLocationIn(locations, "accounts/1/locations/2")?.resourceName).toBe("accounts/1/locations/2");
    expect(savedLocationIn(locations, " A ")?.resourceName).toBe("accounts/1/locations/1");
    expect(savedLocationIn(locations, "B")).toBeNull();
    expect(savedLocationIn(locations, "accounts/9/locations/9")).toBeNull();
    expect(savedLocationIn(locations, null)).toBeNull();
  });
});
