import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  getWorkspaceContext: vi.fn(),
  refreshAccessToken: vi.fn(),
  fetchNewReviewUri: vi.fn(),
  checkRateLimit: vi.fn(),
  flagRejectedToken: vi.fn(),
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
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: mocks.flagRejectedToken,
}));
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
    refreshToken: "gbp-refresh",
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
  mocks.flagRejectedToken.mockResolvedValue("flagged");
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

  // R32 client-journey L4: the panel names the location its link is for (the saved one).
  it("names the saved location's title with the link, saved or fresh", async () => {
    mocks.findFirst.mockResolvedValue(
      connection({
        metadata: { locationName: LOCATION, locationTitle: " Branch A ", newReviewUri: LINK, newReviewUriFor: LOCATION },
      }),
    );
    await expect((await GET()).json()).resolves.toEqual({ url: LINK, location: "Branch A", locationId: LOCATION });

    mocks.findFirst.mockResolvedValue(connection({ metadata: { locationName: LOCATION, locationTitle: "Branch A" } }));
    mocks.fetchNewReviewUri.mockResolvedValue(LINK);
    mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });
    await expect((await GET()).json()).resolves.toEqual({ url: LINK, location: "Branch A", locationId: LOCATION });
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
    expect((await (await GET()).json()).reason).toMatch(/Sign in to Google again/);

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
      reason: "Google no longer accepts this connection. Sign in to Google again with the account that manages this listing to get your review link.",
      signIn: true,
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

    // R25 platform-clients L2: an API 401 flags the row (the token that call
    // sent), so the card shows Reconnect; the owner keeps the in-place sign-in.
    it("a 401 flags the row and says Reconnect, with the in-place sign-in for an owner", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 401, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

      expect(await (await GET()).json()).toEqual({
        url: null,
        reason: "Google no longer accepts this connection. Sign in to Google again with the account that manages this listing to get your review link.",
        signIn: true,
      });
      expect(mocks.flagRejectedToken).toHaveBeenCalledWith(
        { id: "conn-1", accessToken: "gbp-access", refreshToken: "gbp-refresh" },
        "GOOGLE_API_TOKEN_REJECTED",
      );
    });

    it("a 5xx flags nothing", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 503, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

      await GET();

      expect(mocks.flagRejectedToken).not.toHaveBeenCalled();
    });

    // R25 platform-clients L3: retrying never helps; choosing the location again does.
    it("a saved store code that no longer matches says to choose the location again", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ code: "GBP_STORE_CODE_NOT_FOUND" }));

      expect((await (await GET()).json()).reason).toBe(
        "The saved store code no longer matches one Google Business Profile location. Choose the location again in Settings.",
      );
    });

    it("a refresh that flags the row says Reconnect, as the card does", async () => {
      mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() - 60 * 1000) }));
      mocks.refreshAccessToken.mockRejectedValue(failing({ code: "RECONNECT_REQUIRED" }));

      expect((await (await GET()).json()).reason).toBe(
        "Google no longer accepts this connection. Sign in to Google again with the account that manages this listing to get your review link.",
      );
    });

    // JJ3 lead review: the chosen location was removed from Google Business Profile.
    it("a 404 on the location says it is gone and to choose another", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(failing({ status: 404, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));

      expect((await (await GET()).json()).reason).toBe(
        "This location is no longer in Google Business Profile. Choose another location in Settings.",
      );
    });

    // R25 client-journey L1: the in-place sign-in keeps the row, its numbers and the location.
    it("a 403 permission refusal offers the in-place sign-in, and flags nothing", async () => {
      mocks.fetchNewReviewUri.mockRejectedValue(
        failing({ status: 403, code: "GBP_REVIEW_LINK_FETCH_FAILED", googleReasons: [] }),
      );

      expect(await (await GET()).json()).toEqual({
        url: null,
        reason:
          "Google refused access to this location: the connected Google account may no longer manage it. Sign in to Google again with the account that manages this location.",
        signIn: true,
      });
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.flagRejectedToken).not.toHaveBeenCalled();
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
      expect(await (await GET()).json()).toEqual({
        url: null,
        reason: "The workspace owner can reconnect Google Business Profile; then the review link shows here.",
      });

      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ status: 404, code: "GBP_REVIEW_LINK_FETCH_FAILED" }));
      expect((await (await GET()).json()).reason).toBe(
        "This location is no longer in Google Business Profile. The workspace owner can choose another location.",
      );

      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ status: 403 }));
      expect(await (await GET()).json()).toEqual({
        url: null,
        reason:
          "Google refused access to this location: the connected Google account may no longer manage it. The workspace owner can sign in to Google again with the account that manages it.",
      });

      mocks.fetchNewReviewUri.mockRejectedValueOnce(failing({ code: "GBP_STORE_CODE_NOT_UNIQUE" }));
      expect((await (await GET()).json()).reason).toBe(
        "The saved store code no longer matches one Google Business Profile location. The workspace owner can choose the location again.",
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
    expect(body.reason).toMatch(/Sign in to Google again/);
    expect(body.signIn).toBe(true);
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

// R26 platform-clients L1: a 401 on a token that ran out on the way (the early
// refresh had failed) is refreshed once and the link read once more.
describe("GET /api/reviews/link and a 401 on a token that ran out on the way", () => {
  it("refreshes once and reads the link with the new token: nothing flagged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mocks.getWorkspaceContext.mockResolvedValue(context("ws-1", "owner"));
      mocks.checkRateLimit.mockResolvedValue({ allowed: true });
      mocks.findFirst.mockResolvedValue(connection({ expiresAt: new Date(Date.now() + 60 * 1000) }));
      mocks.findUnique.mockResolvedValue({ metadata: { locationName: LOCATION } });
      mocks.refreshAccessToken
        .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "CONNECTION_REFRESH_BUSY" }))
        .mockResolvedValueOnce(connection({ accessToken: "gbp-access-2", expiresAt: new Date(Date.now() + 3_600_000) }));
      mocks.fetchNewReviewUri
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + 2 * 60 * 1000);
          throw Object.assign(new Error("401"), { status: 401, code: "GBP_REVIEW_LINK_FETCH_FAILED" });
        })
        .mockResolvedValueOnce(LINK);

      await expect((await GET()).json()).resolves.toEqual({ url: LINK });
      expect(mocks.fetchNewReviewUri.mock.calls.map(([token]) => token)).toEqual(["gbp-access", "gbp-access-2"]);
      expect(mocks.flagRejectedToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// R27 lead review: in a stale tab the panel showed the other client's link,
// which an owner could send to this client's customers. The panel names the
// workspace it was drawn for; another one is refused before any Google call.
describe("GET /api/reviews/link and the page's workspace", () => {
  const at = (query: string) => new Request(`http://localhost/api/reviews/link${query}`);

  it("refuses a page drawn for another workspace with 409 WORKSPACE_CHANGED, reading nothing", async () => {
    const response = await GET(at("?workspaceId=ws-other"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  it("serves the page's own workspace as today", async () => {
    mocks.findFirst.mockResolvedValue(connection({ metadata: { locationName: LOCATION, newReviewUri: LINK, newReviewUriFor: LOCATION } }));

    const response = await GET(at("?workspaceId=ws-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: LINK });
  });

  it("a page that sent no id (drawn before it did) is served as before", async () => {
    mocks.findFirst.mockResolvedValue(connection({ metadata: { locationName: LOCATION, newReviewUri: LINK, newReviewUriFor: LOCATION } }));

    const response = await GET(at(""));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: LINK });
  });
});
