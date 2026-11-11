import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, connectionFindUniqueMock, metricFindFirstMock, metricFindManyMock } = vi.hoisted(
  () => ({
    getWorkspaceContextMock: vi.fn(),
    connectionFindUniqueMock: vi.fn(),
    metricFindFirstMock: vi.fn(),
    metricFindManyMock: vi.fn(),
  }),
);

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findUnique: connectionFindUniqueMock },
    locationMetricDaily: { findFirst: metricFindFirstMock, findMany: metricFindManyMock },
  },
}));

import { GET, LISTING_METRICS_WINDOW_DAYS } from "./route";

const LOCATION = "accounts/1/locations/22";
const OLD_LOCATION = "accounts/1/locations/99";
type Count = "searchViews" | "mapsViews" | "calls" | "directionRequests" | "websiteClicks";

interface TableRow extends Record<Count, number> {
  workspaceId: string;
  locationName: string;
  day: Date;
}

function at(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

/** `count` consecutive days ending on `end` for one workspace and location. */
function span(workspaceId: string, locationName: string, end: string, count: number, over: Partial<TableRow> = {}) {
  return Array.from({ length: count }, (_, i): TableRow => ({
    workspaceId,
    locationName,
    day: new Date(at(end).getTime() - i * 86_400_000),
    searchViews: 1,
    mapsViews: 1,
    calls: 1,
    directionRequests: 1,
    websiteClicks: 1,
    ...over,
  }));
}

let table: TableRow[] = [];

type Where = {
  workspaceId: string;
  locationName: string;
  day?: { gte?: Date; lte?: Date };
  OR?: Array<Record<string, { gt: number }>>;
};

/** A small Prisma stand-in over `table`: proves which rows the route's filters let through. */
function matches(row: TableRow, where: Where): boolean {
  if (row.workspaceId !== where.workspaceId || row.locationName !== where.locationName) return false;
  if (where.day?.gte && row.day < where.day.gte) return false;
  if (where.day?.lte && row.day > where.day.lte) return false;
  if (where.OR && !where.OR.some((clause) => Object.entries(clause).some(([k, v]) => row[k as Count] > v.gt)))
    return false;
  return true;
}

function sorted(rows: TableRow[], orderBy?: { day: "asc" | "desc" }) {
  return [...rows].sort((a, b) => (orderBy?.day === "desc" ? -1 : 1) * (a.day.getTime() - b.day.getTime()));
}

function pick(row: TableRow) {
  return { day: row.day, searchViews: row.searchViews, mapsViews: row.mapsViews, calls: row.calls, directionRequests: row.directionRequests, websiteClicks: row.websiteClicks };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  connectionFindUniqueMock.mockReset();
  metricFindFirstMock.mockReset();
  metricFindManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
  connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: LOCATION, locationTitle: "Surf Co" } });
  table = [];
  metricFindFirstMock.mockImplementation(async ({ where, orderBy }: { where: Where; orderBy: { day: "desc" } }) => {
    const found = sorted(table.filter((r) => matches(r, where)), orderBy)[0];
    return found ? { day: found.day } : null;
  });
  metricFindManyMock.mockImplementation(async ({ where, orderBy, take }: { where: Where; orderBy?: { day: "asc" | "desc" }; take?: number }) =>
    sorted(table.filter((r) => matches(r, where)), orderBy).slice(0, take).map(pick),
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
    table = span("ws-1", LOCATION, "2026-11-07", 56, { calls: 2 });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "google_business_profile" } },
      select: { metadata: true },
    });
    expect(body).toEqual({
      listing: {
        title: "Surf Co",
        windowDays: LISTING_METRICS_WINDOW_DAYS,
        endDay: "2026-11-07",
        current: { views: 56, calls: 56, directionRequests: 28, websiteClicks: 28 },
        previous: { views: 56, calls: 56, directionRequests: 28, websiteClicks: 28 },
      },
    });
  });

  it("selects rows by date, so both windows are whole after the end moves back past uncounted days", async () => {
    table = [
      // Twelve newest days Google has not counted yet: no value, so zero.
      ...span("ws-1", LOCATION, "2026-11-19", 12, { searchViews: 0, mapsViews: 0, calls: 0, directionRequests: 0, websiteClicks: 0 }),
      ...span("ws-1", LOCATION, "2026-11-07", 56),
      // Older than both windows.
      ...span("ws-1", LOCATION, "2026-09-12", 30, { calls: 100 }),
    ];

    const body = await (await GET()).json();

    expect(body.listing.endDay).toBe("2026-11-07");
    expect(body.listing.current.calls).toBe(28);
    expect(body.listing.previous.calls).toBe(28);
    // Every row read is inside the two windows, whatever the row count.
    for (const call of metricFindManyMock.mock.calls) {
      expect(call[0]).not.toHaveProperty("take");
      expect(call[0].where.day.gte).toEqual(at("2026-09-13"));
    }
  });

  it("never shows another workspace's rows or the old listing's", async () => {
    table = [
      ...span("ws-1", LOCATION, "2026-11-07", 3, { calls: 1 }),
      ...span("ws-1", OLD_LOCATION, "2026-11-06", 60, { calls: 100 }),
      ...span("ws-2", LOCATION, "2026-11-07", 60, { calls: 1000 }),
    ];

    const body = await (await GET()).json();

    expect(body.listing.current.calls).toBe(3);
    expect(body.listing.previous).toBeNull();
    for (const call of [...metricFindFirstMock.mock.calls, ...metricFindManyMock.mock.calls]) {
      expect(call[0].where).toMatchObject({ workspaceId: "ws-1", locationName: LOCATION });
    }
  });

  it("uses the workspace name when the listing has no saved title", async () => {
    table = span("ws-1", LOCATION, "2026-11-07", 1);
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: LOCATION } });
    expect((await (await GET()).json()).listing.title).toBe("Acme");
  });

  it("after a change of listing shows only the new listing's numbers", async () => {
    table = [...span("ws-1", LOCATION, "2026-11-07", 60, { calls: 1 }), ...span("ws-1", OLD_LOCATION, "2026-11-07", 2, { calls: 7 })];
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: OLD_LOCATION, locationTitle: "Old" } });
    const body = await (await GET()).json();
    expect(body.listing.current.calls).toBe(14);
    expect(body.listing.previous).toBeNull();
  });

  it("answers an empty listing, not an error, with no Google connection, no location or no stored day", async () => {
    connectionFindUniqueMock.mockResolvedValueOnce(null);
    let res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listing: null });

    connectionFindUniqueMock.mockResolvedValueOnce({ metadata: {} });
    expect(await (await GET()).json()).toEqual({ listing: null });

    res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listing: null });
  });
});
