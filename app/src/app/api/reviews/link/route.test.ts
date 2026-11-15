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

  it("says why there is no link: not connected", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/Connect Google Business Profile/);
  });

  it("says why there is no link: no location chosen, without calling Google", async () => {
    mocks.findFirst.mockResolvedValue(connection({ metadata: {} }));

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/location/);
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  it("says why there is no link: the connection needs reconnecting", async () => {
    mocks.findFirst.mockResolvedValue(connection({ needsReconnect: true }));

    const body = await (await GET()).json();

    expect(body.url).toBeNull();
    expect(body.reason).toMatch(/Reconnect/);
    expect(mocks.fetchNewReviewUri).not.toHaveBeenCalled();
  });

  it("says why there is no link: Google returned none, and saves nothing", async () => {
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
