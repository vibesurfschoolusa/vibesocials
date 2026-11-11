import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, connectionFindUniqueMock, metricFindManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  connectionFindUniqueMock: vi.fn(),
  metricFindManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findUnique: connectionFindUniqueMock },
    locationMetricDaily: { findMany: metricFindManyMock },
  },
}));

import { GET, LISTING_METRICS_WINDOW_DAYS } from "./route";

const LOCATION = "accounts/1/locations/22";
const OLD_LOCATION = "accounts/1/locations/99";

function dbRow(day: string, over: Record<string, unknown> = {}) {
  return {
    day: new Date(`${day}T00:00:00.000Z`),
    searchViews: 1,
    mapsViews: 1,
    calls: 1,
    directionRequests: 1,
    websiteClicks: 1,
    ...over,
  };
}

/** The table, filtered as the route asks: proves another workspace's or location's rows are never read. */
const TABLE = [
  { workspaceId: "ws-1", locationName: LOCATION, ...dbRow("2026-11-07", { calls: 5 }) },
  { workspaceId: "ws-1", locationName: LOCATION, ...dbRow("2026-10-01", { calls: 2 }) },
  { workspaceId: "ws-1", locationName: OLD_LOCATION, ...dbRow("2026-11-06", { calls: 100 }) },
  { workspaceId: "ws-2", locationName: LOCATION, ...dbRow("2026-11-07", { calls: 1000 }) },
];

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  connectionFindUniqueMock.mockReset();
  metricFindManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
  connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: LOCATION, locationTitle: "Surf Co" } });
  metricFindManyMock.mockImplementation(
    async ({ where, take }: { where: { workspaceId: string; locationName: string }; take: number }) =>
      TABLE.filter((r) => r.workspaceId === where.workspaceId && r.locationName === where.locationName)
        .sort((a, b) => b.day.getTime() - a.day.getTime())
        .slice(0, take)
        .map((r) => dbRow(r.day.toISOString().slice(0, 10), { calls: r.calls })),
  );
});

describe("GET /api/insights/listing-metrics", () => {
  it("401s without a workspace and reads nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
    expect(metricFindManyMock).not.toHaveBeenCalled();
  });

  it("serves any member the active workspace's current listing, with both 28-day totals", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "google_business_profile" } },
      select: { metadata: true },
    });
    expect(metricFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { workspaceId: "ws-1", locationName: LOCATION },
      orderBy: { day: "desc" },
      take: 2 * LISTING_METRICS_WINDOW_DAYS,
    });
    expect(body).toEqual({
      listing: {
        title: "Surf Co",
        windowDays: 28,
        endDay: "2026-11-07",
        current: { views: 2, calls: 5, directionRequests: 1, websiteClicks: 1 },
        previous: { views: 2, calls: 2, directionRequests: 1, websiteClicks: 1 },
      },
    });
  });

  it("never shows another workspace's rows or the old listing's", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-2" }));
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: LOCATION } });

    const body = await (await GET()).json();

    expect(body.listing.current.calls).toBe(1000);
    expect(body.listing.previous).toBeNull();
    // The workspace name stands in for a listing with no saved title.
    expect(body.listing.title).toBe("Acme");
  });

  it("after a change of listing shows only the new listing's numbers", async () => {
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: OLD_LOCATION, locationTitle: "Old" } });
    const body = await (await GET()).json();
    expect(body.listing.current.calls).toBe(100);
    expect(body.listing.previous).toBeNull();
  });

  it("answers an empty listing, not an error, with no Google connection, no location or no stored day", async () => {
    connectionFindUniqueMock.mockResolvedValueOnce(null);
    let res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listing: null });

    connectionFindUniqueMock.mockResolvedValueOnce({ metadata: {} });
    expect(await (await GET()).json()).toEqual({ listing: null });

    connectionFindUniqueMock.mockResolvedValueOnce({ metadata: { locationName: "accounts/1/locations/none" } });
    res = await GET();
    expect(await res.json()).toEqual({ listing: null });
  });
});
