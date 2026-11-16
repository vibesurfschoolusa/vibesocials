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

import {
  GOOGLE_ACCESS_REFUSED_MESSAGE,
  GOOGLE_NOT_ANSWERING_MESSAGE,
  GOOGLE_REFUSED_MEMBER_MESSAGE,
  GOOGLE_REFUSED_MESSAGE,
  refreshAccessToken,
} from "@/server/googleReviews";

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

  it("asks for a reconnect when Google refuses the token (401)", async () => {
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed to fetch Google Business Profile reviews (status 401)"), { status: 401 }),
    );

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });

  // JJ3 lead review: a 403 is not a dead grant; reconnecting fixes neither case.
  it("a 403 permission refusal says to check the account, with no reconnect flag", async () => {
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    fetchAllReviewsMock.mockRejectedValue(
      Object.assign(new Error("Failed (status 403)"), { status: 403, googleReasons: ["forbidden"] }),
    );

    await expect((await get()).json()).resolves.toEqual({ error: GOOGLE_ACCESS_REFUSED_MESSAGE });
  });

  it("a 403 for a disabled service says to try later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
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
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    findFirstMock.mockResolvedValue({ id: "c1", accessToken: null, expiresAt: null, metadata: {} });

    const body = (await (await get()).json()) as { error: string; reconnect?: boolean };

    expect(body).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
  });
});

// R12 L1: only an owner can reconnect, so a member reads who can, without the
// reconnect flag that makes the page link to Settings.
describe("GET /api/reviews for a member", () => {
  it("Google refuses: who can reconnect, no Settings link", async () => {
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
        "Google refused access to this location. The workspace owner can check that the connected Google account still manages it in Google Business Profile.",
    });
    const lines = warn.mock.calls.filter(([message]) => message === "[Google] request failed");
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ where: "GET /api/reviews", kind: "access", status: 403 });
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
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
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
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});

// Lead review (R23): a connection Google has revoked (flagged needsReconnect)
// gets the reconnect text at once, as the link route does, and Google is not asked.
describe("GET /api/reviews for a connection flagged for reconnect", () => {
  it("answers with the reconnect text and asks Google nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
    findFirstMock.mockResolvedValue({
      id: "c1",
      accessToken: "tok",
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      needsReconnect: true,
      metadata: { locationName: "accounts/1/locations/2" },
    });

    const response = await get();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});
