import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  getWorkspaceContext: vi.fn(),
  refreshAccessToken: vi.fn(),
  fetchNewReviewUri: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findFirst: mocks.findFirst, findUnique: mocks.findUnique, update: mocks.update },
  },
}));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
// savedNewReviewUri stays real: it is the rule for which saved link counts.
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  refreshAccessToken: mocks.refreshAccessToken,
  fetchNewReviewUri: mocks.fetchNewReviewUri,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "./route";

const LOCATION = "accounts/1/locations/22";
const LINK = "https://g.page/r/abc/review";

function context(workspaceId = "ws-1", role: "owner" | "member" = "member") {
  return {
    user: { id: `user-${workspaceId}` },
    workspace: { id: workspaceId, name: "Surf Co" },
    role,
    memberCount: 2,
  };
}

function connection(over: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    platform: "google_business_profile",
    accessToken: "gbp-access",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    needsReconnect: false,
    metadata: { locationName: LOCATION },
    ...over,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getWorkspaceContext.mockResolvedValue(context());
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.update.mockResolvedValue({});
});

describe("GET /api/reviews/link", () => {
  it("returns 401 for someone who is not a member of a workspace", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("returns 429 when the caller is over the rate limit", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await GET();

    expect(response.status).toBe(429);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("returns the saved link without calling Google", async () => {
    mocks.findFirst.mockResolvedValue(
      connection({ metadata: { locationName: LOCATION, newReviewUri: LINK, newReviewUriFor: LOCATION } }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: LINK });
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fetches the link when it is missing and saves it, merged onto the row as it is now", async () => {
    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({
      metadata: { locationName: LOCATION, reviewsSeenThrough: "2026-11-10T08:00:00Z" },
    });

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ url: LINK });
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledWith("gbp-access", LOCATION);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        metadata: {
          locationName: LOCATION,
          reviewsSeenThrough: "2026-11-10T08:00:00Z",
          newReviewUri: LINK,
          newReviewUriFor: LOCATION,
        },
      },
    });
  });

  it("does not save a link for a location that was replaced meanwhile, but still returns it", async () => {
    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: "accounts/1/locations/99" } });

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ url: LINK });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fetches again when the saved link belongs to a location that is no longer chosen", async () => {
    mocks.findFirst.mockResolvedValue(
      connection({
        metadata: { locationName: LOCATION, newReviewUri: "https://old/review", newReviewUriFor: "accounts/1/locations/9" },
      }),
    );
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });

    await expect((await GET()).json()).resolves.toEqual({ url: LINK });
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired token before asking Google", async () => {
    const expired = connection({ expiresAt: new Date(Date.now() - 1000) });
    mocks.findFirst.mockResolvedValue(expired);
    mocks.refreshAccessToken.mockResolvedValue({ ...expired, accessToken: "gbp-access-2" });
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });

    await GET();

    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledWith("gbp-access-2", LOCATION);
  });

  // R23 client-journey L1: a token in its last 5 minutes is refreshed first.
  it("refreshes a token with 4 minutes left before asking Google", async () => {
    const expiring = connection({ expiresAt: new Date(Date.now() + 4 * 60 * 1000) });
    mocks.findFirst.mockResolvedValue(expiring);
    mocks.refreshAccessToken.mockResolvedValue({ ...expiring, accessToken: "gbp-access-2" });
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });

    await GET();

    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledWith("gbp-access-2", LOCATION);
  });

  it("leaves a token with 10 minutes left alone", async () => {
    mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() + 10 * 60 * 1000) }));
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });

    await GET();

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledWith("gbp-access", LOCATION);
  });

  it("a failed refresh with 4 minutes left serves the request with the stored token", async () => {
    mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() + 4 * 60 * 1000) }));
    mocks.refreshAccessToken.mockRejectedValue(Object.assign(new Error("down"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 503 }));
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });

    await expect((await GET()).json()).resolves.toEqual({ url: LINK });
    expect(mocks.fetchNewReviewUri).toHaveBeenCalledWith("gbp-access", LOCATION);
  });

  it("a failed refresh after expiry keeps today's reasons", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() - 60 * 1000) }));
    mocks.refreshAccessToken.mockRejectedValueOnce(Object.assign(new Error("dead"), { code: "RECONNECT_REQUIRED" }));
    expect((await (await GET()).json()).reason).toMatch(/Reconnect/);

    mocks.refreshAccessToken.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 503 }));
    expect((await (await GET()).json()).reason).toMatch(/Try again later/);
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  // JJ3 lead review: the panel follows the rule the Reviews routes use
  // (reviewsErrorBody), so a refresh that flags the row reads "Reconnect".
  it("an expired token whose refresh Google refuses (invalid_grant) says reconnect", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() - 60 * 1000) }));
    mocks.refreshAccessToken.mockRejectedValue(
      Object.assign(new Error("refused"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 400, oauthError: "invalid_grant" }),
    );

    const body = await (await GET()).json();

    expect(body).toEqual({
      url: null,
      reason: "Reconnect Google Business Profile in Settings, Connections to get your review link.",
    });
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  // JJ3 lead review: a 5xx is "try later" on every Google surface now.
  it("an expired token whose refresh gets a 5xx says to try later", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() - 60 * 1000) }));
    mocks.refreshAccessToken.mockRejectedValue(
      Object.assign(new Error("down"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 502 }),
    );

    expect((await (await GET()).json()).reason).toBe(
      "Google Business Profile isn't answering for Vibe Socials right now. Try again later.",
    );
  });

  // JJ3 lead review: Google's link answer goes through the shared rule.
  describe("Google refusing the link request", () => {
    const failing = (fields: Record<string, unknown>) => Object.assign(new Error("refused"), fields);

    beforeEach(() => {
      mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
      mocks.findFirst.mockResolvedValue(connection());
    });

    // JJ3 lead review: an API 401 flags nothing, so the card shows Switch account, not Reconnect.
    it("a 401 says to press Switch account and sign in again", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 401, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

      expect((await (await GET()).json()).reason).toBe(
        "Press Switch account on the Google Business Profile card in Settings and sign in again to get your review link.",
      );
    });

    it("a refresh that flags the row says Reconnect, as the card does", async () => {
      mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() - 60 * 1000) }));
      mocks.refreshAccessToken.mockRejectedValue(failing({ code: "RECONNECT_REQUIRED" }));

      expect((await (await GET()).json()).reason).toBe(
        "Reconnect Google Business Profile in Settings, Connections to get your review link.",
      );
    });

    // JJ3 lead review: the chosen location was removed from Google Business Profile.
    it("a 404 on the location says it is gone and to choose another", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 404, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

      expect((await (await GET()).json()).reason).toBe(
        "This location is no longer in Google Business Profile. Choose another location in Settings.",
      );
    });

    it("a 403 permission refusal says to check the account, and flags nothing", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(
        failing({ status: 403, code: "GBP_REVIEW_LINK_FETCH_FAILED", googleReasons: [] }),
      );

      expect((await (await GET()).json()).reason).toBe(
        "Google refused access to this location. Check that the connected Google account still manages it in Google Business Profile, or press Switch account on the Google Business Profile card in Settings and sign in with an account that does.",
      );
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it("a 403 for a disabled service says to try later", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.fetchNewReviewUri.mockRejectedValue(
        failing({ status: 403, code: "GBP_REVIEW_LINK_FETCH_FAILED", googleReasons: ["servicedisabled"] }),
      );

      expect((await (await GET()).json()).reason).toBe(
        "Google Business Profile isn't answering for Vibe Socials right now. Try again later.",
      );
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it("a member reads who can take each step, never the step itself", async () => {
      mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "member"));
      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ status: 401 }));
      expect((await (await GET()).json()).reason).toBe(
        "The workspace owner can sign in to Google Business Profile again; then the review link shows here.",
      );

      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ status: 404, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));
      expect((await (await GET()).json()).reason).toBe(
        "This location is no longer in Google Business Profile. The workspace owner can choose another location.",
      );

      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ status: 403 }));
      expect((await (await GET()).json()).reason).toBe(
        "Google refused access to this location. The workspace owner can check that the connected Google account still manages it in Google Business Profile.",
      );
    });

    it("anything else keeps today's text, and each failure is logged once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      warn.mockClear();
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 404 }));

      expect((await (await GET()).json()).reason).toBe(
        "Couldn't get your review link from Google. Reload this page to try again.",
      );
      const lines = warn.mock.calls.filter(([message]) => message === "[Google] request failed");
      expect(lines).toHaveLength(1);
      expect(lines[0][1]).toMatchObject({ where: "GET /api/reviews/link", kind: "other", status: 404 });
    });
  });

  it("says why there is no link: not connected", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/Connect Google Business Profile/);
  });

  it("says why there is no link: no location chosen, without calling Google", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection({ metadata: {} }));

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toBe(
      "Choose your Maps location for Google Business Profile in Settings, Connections to get your review link.",
    );
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  it("says why there is no link: the connection needs reconnecting", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection({ needsReconnect: true }));

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/Reconnect/);
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  it("says why there is no link: Google returned none, and saves nothing", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/Google has no review link/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("says what to do when Google fails", async () => {
    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockRejectedValue(Object.assign(new Error("403"), { code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/try again/);
  });

  it("reads only the caller's own workspace's connection", async () => {
    mocks.getWorkspaceContext.mockResolvedValue(context("ws-2"));
    mocks.findFirst.mockImplementation(async ({ where }: { where: { workspaceId: string } }) =>
      where.workspaceId === "ws-1"
        ? connection({ metadata: { locationName: LOCATION, newReviewUri: LINK, newReviewUriFor: LOCATION } })
        : null,
    );

    const body = await (await GET()).json();

    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({
      workspaceId: "ws-2",
      platform: "google_business_profile",
    });
    expect(body.url).toBeNull();
  });
});

// R12 L1: only an owner can connect, choose the location or reconnect, so a
// member (who may read the panel) reads who can, never a step in Settings.
describe("GET /api/reviews/link for a member", () => {
  const ask = async () => (await (await GET()).json()) as { url: string | null; reason?: string };

  it("not connected", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await ask()).toEqual({
      url: null,
      reason: "The workspace owner can connect Google Business Profile; then the review link shows here.",
    });
  });

  it("no location chosen", async () => {
    mocks.findFirst.mockResolvedValue(connection({ metadata: {} }));
    expect(await ask()).toEqual({
      url: null,
      reason: "The workspace owner can choose the Maps location for Google Business Profile; then the review link shows here.",
    });
  });

  it("needs reconnecting, flagged or found when Google refuses", async () => {
    const reason = "The workspace owner can reconnect Google Business Profile; then the review link shows here.";
    mocks.findFirst.mockResolvedValue(connection({ needsReconnect: true }));
    expect(await ask()).toEqual({ url: null, reason });

    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockRejectedValue(Object.assign(new Error("401"), { code: "RECONNECT_REQUIRED" }));
    expect(await ask()).toEqual({ url: null, reason });
  });

  it("Google has none", async () => {
    mocks.findFirst.mockResolvedValue(connection());
    mocks.fetchNewReviewUri.mockResolvedValue(null);
    expect(await ask()).toEqual({
      url: null,
      reason:
        "Google has no review link for this location yet. The workspace owner can check that the listing is verified in Google Business Profile.",
    });
  });
});
