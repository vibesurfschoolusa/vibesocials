import { beforeEach, describe, expect, it, vi } from "vitest";

// F7 (R1 M4, M5): GET /api/reviews loads every page and never shows Google's
// own error text. Google itself is stubbed out (server/googleReviews.ts).
const { getWorkspaceContextMock, findFirstMock, fetchAllReviewsMock, checkRateLimitMock, flagRejectedTokenMock, listMock } =
  vi.hoisted(() => ({
    getWorkspaceContextMock: vi.fn(),
    findFirstMock: vi.fn(),
    fetchAllReviewsMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    flagRejectedTokenMock: vi.fn(),
    listMock: vi.fn(),
  }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: flagRejectedTokenMock,
}));
vi.mock("@/app/api/connections/google_business_profile/gbpLocations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/connections/google_business_profile/gbpLocations")>()),
  listGbpLocationsWithToken: listMock,
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: findFirstMock } } }));
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  fetchAllReviews: fetchAllReviewsMock,
  refreshAccessToken: vi.fn(),
}));

import {
  GOOGLE_ACCESS_REFUSED_MESSAGE,
  GOOGLE_NOT_ANSWERING_MESSAGE,
  GOOGLE_REFUSED_MEMBER_MESSAGE,
  GOOGLE_REFUSED_MESSAGE,
  MEMBER_OTHER_LOCATION_MESSAGE,
  refreshAccessToken,
} from "@/server/googleReviews";

import { GET } from "./route";

const get = () => GET(new Request("http://localhost/api/reviews?location=accounts%2F1%2Flocations%2F2"));

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
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  flagRejectedTokenMock.mockResolvedValue("flagged");
});

const OWNER = { user: { id: "u1" }, workspace: { id: "ws-1" }, role: "owner" };

const listed = (resourceName: string, storeCode: string | null = null) => ({
  resourceName,
  title: "Shop",
  storeCode,
  address: null,
  accountName: "A",
});
const listing = (locations: ReturnType<typeof listed>[]) => ({
  ok: true,
  locations,
  complete: true,
  unread: { access: false, failed: false },
  refusedOnly: false,
  skippedFailure: null,
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

  // R25 platform-clients L2: an API 401 flags the row (the token that call
  // sent), so the card shows Reconnect; the owner keeps the in-place sign-in.
  it("a 401 flags the row and reads Reconnect, with the in-place sign-in", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed to fetch Google Business Profile reviews (status 401)"), { status: 401 }),
    );

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
    expect(flagRejectedTokenMock).toHaveBeenCalledWith(
      { id: "c1", accessToken: "tok", refreshToken: "ref" },
      "GOOGLE_API_TOKEN_REJECTED",
    );
  });

  it.each([429, 503])("a %i flags nothing", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("Failed"), { status }));

    await get();

    expect(flagRejectedTokenMock).not.toHaveBeenCalled();
  });

  // R25 client-journey L1: the in-place sign-in keeps the row, its numbers and the location.
  it("a 403 permission refusal offers the in-place sign-in with the account that manages the location", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed (status 403)"), { status: 403, googleReasons: ["forbidden"] }),
    );

    await expect((await get()).json()).resolves.toEqual({
      error: GOOGLE_ACCESS_REFUSED_MESSAGE,
      reconnect: true,
      signIn: true,
    });
    expect(GOOGLE_ACCESS_REFUSED_MESSAGE).toBe(
      "Google refused access to this location: the connected Google account may no longer manage it. Sign in to Google again with the account that manages this location.",
    );
    expect(flagRejectedTokenMock).not.toHaveBeenCalled();
  });

  // R25 platform-clients L3: retrying never helps; choosing the location again does.
  it("a saved store code that no longer matches says to choose the location again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("not found"), { code: "GBP_STORE_CODE_NOT_FOUND" }));

    await expect((await get()).json()).resolves.toEqual({
      error: "The saved store code no longer matches one Google Business Profile location. Choose the location again in Settings.",
      reconnect: true,
    });

    getWorkspaceContextMock.mockResolvedValue({ ...OWNER, role: "member" });
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("not unique"), { code: "GBP_STORE_CODE_NOT_UNIQUE" }));
    await expect((await get()).json()).resolves.toEqual({
      error: "The saved store code no longer matches one Google Business Profile location. The workspace owner can choose the location again.",
    });
  });

  it("a 403 for a disabled service says to try later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed (status 403)"), { status: 403, googleReasons: ["servicedisabled"] }),
    );

    await expect((await get()).json()).resolves.toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
  });

  it("gives a plain sentence for anything else, not the error's text", async () => {
    fetchAllReviewsMock.mockRejectedValue(new SyntaxError("Unexpected token < in JSON at position 0"));

    const response = await get();
    const body = (await response.json()) as { error: string };

    expect(body.error).toBe("Couldn't load your Google reviews. Try again in a minute.");
    expect(body.error).not.toContain("JSON");
  });

  it("asks for a reconnect when the connection holds no token", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: null, expiresAt: null, metadata: {} });

    const body = (await (await get()).json()) as { error: string; reconnect?: boolean };

    expect(body).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
  });

  // R25 security-billing L1: Google counts quota per project, so each person is limited.
  it("over the limit: 429, and Google is not asked", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });

    const response = await get();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "Too many requests. Please slow down.", retryAfterSeconds: 12 });
    expect(checkRateLimitMock).toHaveBeenCalledWith({ userId: "u1", route: "reviews", limit: 60, windowMs: 300_000 });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});

// R25 client-journey L3: with an agency's Google login, a member sees only the
// workspace's own saved location; the owner may read any listed one.
describe("GET /api/reviews and another location", () => {
  const other = () => GET(new Request("http://localhost/api/reviews?location=accounts%2F1%2Flocations%2F7"));

  beforeEach(() => fetchAllReviewsMock.mockResolvedValue({ reviews: [], truncated: false }));

  it("a member asking for another location is refused, and Google is not asked", async () => {
    const response = await other();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: MEMBER_OTHER_LOCATION_MESSAGE });
    expect(MEMBER_OTHER_LOCATION_MESSAGE).toMatch(/workspace owner/);
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });

  it("the owner reads it", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);

    const response = await other();

    expect(response.status).toBe(200);
    expect(fetchAllReviewsMock).toHaveBeenCalledWith("tok", "accounts/1/locations/7");
  });

  it("a member reads the saved location, also when it was saved as a store code", async () => {
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: "tok", expiresAt: null, metadata: { locationName: "FTL-01" } });
    listMock.mockResolvedValue({
      ok: true,
      locations: [
        { resourceName: "accounts/1/locations/2", title: "Main", storeCode: null, address: null, accountName: "A" },
        { resourceName: "accounts/1/locations/7", title: "Beach", storeCode: "FTL-01", address: null, accountName: "A" },
      ],
      complete: true,
      unread: { access: false, failed: false },
      refusedOnly: false,
    });

    expect((await other()).status).toBe(200);
    expect((await get()).status).toBe(403);
  });
});

// R12 L1: only an owner can reconnect, so a member reads who can, without the
// reconnect flag that makes the page link to Settings.
describe("GET /api/reviews for a member", () => {
  it("Google refuses the token: who can reconnect, no Settings link", async () => {
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MEMBER_MESSAGE });
  });

  // JJ3 lead review: each kind, for a member, and one log line per failure.
  it("a 403 permission refusal: who can check the account, and one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("403"), { status: 403, googleReasons: ["forbidden"] }));

    await expect((await get()).json()).resolves.toEqual({
      error:
        "Google refused access to this location: the connected Google account may no longer manage it. The workspace owner can sign in to Google again with the account that manages it.",
    });
    const lines = warn.mock.calls.filter(([message]) => message === "[Google] request failed");
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ where: "GET /api/reviews", kind: "access", status: 403 });
  });

  // JJ3 lead review: the chosen location was removed from Google Business Profile,
  // worded by whether ?location= is the saved one (the page's picker is not saved).
  // R26 client-journey L1: members have no picker, so theirs names the owner and Settings.
  it("a 404 on the saved location's reviews: owner chooses another in Settings, a member reads the owner can", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: null,
      metadata: { locationName: "accounts/1/locations/2" },
    });
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("404"), { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }));

    await expect((await get()).json()).resolves.toEqual({
      error: "This location is no longer in Google Business Profile. The workspace owner can choose another location in Settings.",
    });

    getWorkspaceContextMock.mockResolvedValue(OWNER);
    await expect((await get()).json()).resolves.toEqual({ error: "This location is no longer in Google Business Profile. Choose another location in Settings (it's also where your Google posts go).", reconnect: true });
  });

  it("a 404 on a location the owner picked on the page, not the saved one: pick another above", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: null,
      metadata: { locationName: "accounts/1/locations/9" },
    });
    listMock.mockResolvedValue(listing([listed("accounts/1/locations/9"), listed("accounts/1/locations/3")]));
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("404"), { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }));

    getWorkspaceContextMock.mockResolvedValue(OWNER);
    await expect((await get()).json()).resolves.toEqual({ error: "This location is no longer in Google Business Profile. Pick another location above." });
  });

  // R26 client-journey L1 / pages L5: "picked" is decided by the resolved
  // resource name, and said only where the page shows a picker.
  it("a 404 on the saved store code's own location, asked for by its resource name: the saved wording", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: "tok", expiresAt: null, metadata: { locationName: "FTL-01" } });
    // The listing read afterwards still has it (Google removes it from one list before the other).
    listMock.mockResolvedValue(listing([listed("accounts/1/locations/2", "FTL-01"), listed("accounts/1/locations/3")]));
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("404"), { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }));

    await expect((await get()).json()).resolves.toEqual({
      error: "This location is no longer in Google Business Profile. Choose another location in Settings (it's also where your Google posts go).",
      reconnect: true,
    });
  });

  it("a 404 on a location the owner picked, with one location listed (no picker shown): the Settings wording", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: "tok", expiresAt: null, metadata: { locationName: "accounts/1/locations/9" } });
    listMock.mockResolvedValue(listing([listed("accounts/1/locations/9")]));
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("404"), { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }));

    await expect((await get()).json()).resolves.toEqual({
      error: "This location is no longer in Google Business Profile. Choose another location in Settings (it's also where your Google posts go).",
      reconnect: true,
    });
  });

  it("a member's saved store code gone: the owner can choose another in Settings, never 'pick above'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: "tok", expiresAt: null, metadata: { locationName: "FTL-01" } });
    listMock.mockResolvedValue(listing([listed("accounts/1/locations/2", "FTL-01"), listed("accounts/1/locations/3")]));
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("404"), { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }));

    await expect((await get()).json()).resolves.toEqual({
      error: "This location is no longer in Google Business Profile. The workspace owner can choose another location in Settings.",
    });
  });

  it("Google down: the same try-later sentence as an owner's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchAllReviewsMock.mockRejectedValue(Object.assign(new Error("503"), { status: 503 }));

    await expect((await get()).json()).resolves.toEqual({ error: GOOGLE_NOT_ANSWERING_MESSAGE });
  });

  it("no token: the same", async () => {
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: null, expiresAt: null, metadata: {} });

    await expect((await get()).json()).resolves.toEqual({ error: GOOGLE_REFUSED_MEMBER_MESSAGE });
  });
});

// R23 client-journey L1: a Google token in its last 5 minutes is refreshed
// first (googleTokenExpiresSoon), so a long listing never runs past expiry.
describe("GET /api/reviews and a token about to expire", () => {
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

    await get();

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchAllReviewsMock.mock.calls[0][0]).toBe("fresh");
  });

  it("leaves a token with 10 minutes left alone", async () => {
    expiringIn(10 * MINUTE);

    await get();

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchAllReviewsMock.mock.calls[0][0]).toBe("tok");
  });

  it("a failed refresh with 4 minutes left serves the request with the stored token", async () => {
    expiringIn(4 * MINUTE);
    vi.mocked(refreshAccessToken).mockRejectedValue(
      Object.assign(new Error("Failed to refresh Google access token (status 503)"), {
        code: "GOOGLE_TOKEN_REFRESH_FAILED",
        status: 503,
      }),
    );
    fetchAllReviewsMock.mockResolvedValue({ reviews: [], truncated: false });

    const response = await get();

    expect(response.status).toBe(200);
    expect(fetchAllReviewsMock.mock.calls[0][0]).toBe("tok");
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

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});

// Lead review (R23): a connection Google has revoked (flagged needsReconnect)
// gets the reconnect text at once, as the link route does, and Google is not asked.
describe("GET /api/reviews for a connection flagged for reconnect", () => {
  it("answers with the reconnect text and asks Google nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER);
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      needsReconnect: true,
      metadata: { locationName: "accounts/1/locations/2" },
    });

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});
