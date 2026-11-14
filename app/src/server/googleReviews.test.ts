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
  GOOGLE_REFUSED_MESSAGE,
  REVIEWS_SHOWN_MAX,
  fetchAllReviews,
  fetchNewReviewUri,
  fetchReviews,
  isReviewResourceName,
  reviewsErrorBody,
} from "./googleReviews";

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
    ["a 403 from Google", coded({ status: 403, code: "GBP_REVIEWS_REPLY_FAILED" })],
    ["a connection already flagged for reconnecting", coded({ code: "RECONNECT_REQUIRED" })],
    ["a connection removed meanwhile", coded({ code: "CONNECTION_GONE" })],
    ["a refused token refresh", coded({ status: 400, code: "GOOGLE_TOKEN_REFRESH_FAILED" })],
  ])("asks for a reconnect after %s", (_label, error) => {
    expect(reviewsErrorBody(error, "Fallback.")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
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
    expect(reviewsErrorBody(error, "Fallback.")).toEqual({ error: "Fallback." });
  });
});

// F7 (R1-security L5): the reply goes to the review the name names, so it must name one.
describe("isReviewResourceName", () => {
  it("accepts a review's full resource name", () => {
    expect(isReviewResourceName("accounts/1/locations/2/reviews/AbC-9_x")).toBe(true);
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
    expect(isReviewResourceName(name)).toBe(false);
  });
});
