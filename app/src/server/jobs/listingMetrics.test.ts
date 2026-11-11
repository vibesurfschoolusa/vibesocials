import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
  metricFindFirst: vi.fn(),
  metricUpsert: vi.fn(),
  metricDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));
const { loggerMock, fetchMock, refreshMock, resolveMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fetchMock: vi.fn(),
  refreshMock: vi.fn(),
  resolveMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      findMany: db.connectionFindMany,
      findUnique: db.connectionFindUnique,
      update: db.connectionUpdate,
    },
    locationMetricDaily: {
      findFirst: db.metricFindFirst,
      upsert: db.metricUpsert,
      deleteMany: db.metricDeleteMany,
    },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));
vi.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: fetchMock }));
vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  refreshAccessToken: refreshMock,
}));
vi.mock("@/server/platforms/gbpLocation", () => ({ resolveGbpLocationName: resolveMock }));

import {
  LISTING_METRICS_BUDGET_MS,
  LISTING_METRICS_MAX_DAYS_PER_REQUEST,
  buildListingMetricsUrl,
  fetchListingDailyMetrics,
  listingMetricsRange,
  parseListingMetrics,
  saveListingMetricsCheckedAt,
  splitDayRange,
  syncListingMetrics,
} from "./listingMetrics";

const NOW = new Date("2026-11-10T09:30:00.000Z");
const HOUR = 3_600_000;
const LOCATION = "accounts/1/locations/22";
const OTHER_LOCATION = "accounts/1/locations/99";

interface Row {
  id: string;
  workspaceId: string;
  platform: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  needsReconnect: boolean;
  metadata: Record<string, unknown> | null;
}

function conn(over: Partial<Row> = {}): Row {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    platform: "google_business_profile",
    accessToken: "gbp-access",
    refreshToken: "gbp-refresh",
    expiresAt: new Date(NOW.getTime() + HOUR),
    needsReconnect: false,
    metadata: { locationName: LOCATION, locationTitle: "Surf Co" },
    ...over,
  };
}

function useRows(rows: Row[]) {
  db.connectionFindMany.mockResolvedValue(rows.map((r) => ({ id: r.id, metadata: r.metadata })));
  db.connectionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const found = rows.find((r) => r.id === where.id);
    return found ? { ...found } : null;
  });
}

function date(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

/** A Google answer: per metric, the dated values in order. */
function answer(series: Record<string, Array<[string, string | number | undefined]>>) {
  return {
    multiDailyMetricTimeSeries: [
      {
        dailyMetricTimeSeries: Object.entries(series).map(([dailyMetric, points]) => ({
          dailyMetric,
          timeSeries: {
            datedValues: points.map(([day, value]) => (value === undefined ? { date: date(day) } : { date: date(day), value })),
          },
        })),
      },
    ],
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  for (const mock of [fetchMock, refreshMock, resolveMock]) mock.mockReset();
  for (const mock of Object.values(loggerMock)) mock.mockReset();
  db.connectionUpdate.mockResolvedValue({});
  db.metricFindFirst.mockResolvedValue({ id: "existing" });
  db.metricUpsert.mockImplementation((args: unknown) => args);
  db.transaction.mockImplementation(async (ops: unknown[]) => ops);
  resolveMock.mockImplementation(async (_token: string, name: string) => name);
  fetchMock.mockResolvedValue(okResponse(answer({ CALL_CLICKS: [["2026-11-09", "1"]] })));
});

describe("the request", () => {
  it("asks for the last ten days, ending yesterday (UTC)", () => {
    expect(listingMetricsRange(NOW, 10)).toEqual({ start: "2026-10-31", end: "2026-11-09" });
  });

  it("asks for the last ninety days the first time", () => {
    expect(listingMetricsRange(NOW, 90)).toEqual({ start: "2026-08-12", end: "2026-11-09" });
  });

  it("splits a range longer than one request allows, in order, without gaps", () => {
    const range = { start: "2026-01-01", end: "2026-01-10" };
    expect(splitDayRange(range, 4)).toEqual([
      { start: "2026-01-01", end: "2026-01-04" },
      { start: "2026-01-05", end: "2026-01-08" },
      { start: "2026-01-09", end: "2026-01-10" },
    ]);
    expect(splitDayRange(range, 10)).toEqual([range]);
  });

  it("keeps the ninety-day first request in one request", () => {
    expect(splitDayRange(listingMetricsRange(NOW, 90), LISTING_METRICS_MAX_DAYS_PER_REQUEST)).toHaveLength(1);
  });

  it("names the location as locations/{id} on the Performance API host, with every metric and the range", () => {
    const url = new URL(buildListingMetricsUrl("22", { start: "2026-10-31", end: "2026-11-09" }));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://businessprofileperformance.googleapis.com/v1/locations/22:fetchMultiDailyMetricsTimeSeries",
    );
    expect(url.searchParams.getAll("dailyMetrics")).toEqual([
      "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
      "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
      "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
      "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
      "CALL_CLICKS",
      "BUSINESS_DIRECTION_REQUESTS",
      "WEBSITE_CLICKS",
    ]);
    expect(Object.fromEntries([...url.searchParams].filter(([key]) => key.startsWith("dailyRange")))).toEqual({
      "dailyRange.start_date.year": "2026",
      "dailyRange.start_date.month": "10",
      "dailyRange.start_date.day": "31",
      "dailyRange.end_date.year": "2026",
      "dailyRange.end_date.month": "11",
      "dailyRange.end_date.day": "9",
    });
  });

  it("turns the stored accounts/{a}/locations/{id} into locations/{id}, and sends the token", async () => {
    await fetchListingDailyMetrics("tok", LOCATION, { start: "2026-11-08", end: "2026-11-09" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/locations/22:fetchMultiDailyMetricsTimeSeries?");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("resolves a store code first", async () => {
    resolveMock.mockResolvedValue("accounts/7/locations/333");
    await fetchListingDailyMetrics("tok", "SURF-01", { start: "2026-11-08", end: "2026-11-09" });
    expect(resolveMock).toHaveBeenCalledWith("tok", "SURF-01");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/locations/333:");
  });

  it("sends one request per piece of a split range and joins the days", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(answer({ CALL_CLICKS: [["2026-01-01", "1"]] })))
      .mockResolvedValueOnce(okResponse(answer({ CALL_CLICKS: [["2026-01-03", "2"]] })));
    const days = await fetchListingDailyMetrics("tok", LOCATION, { start: "2026-01-01", end: "2026-01-03" }, 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(days.map((d) => [d.day, d.calls])).toEqual([
      ["2026-01-01", 1],
      ["2026-01-03", 2],
    ]);
  });

  it("throws on a refusal, with a code", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden", text: async () => "{}", json: async () => ({}) });
    await expect(
      fetchListingDailyMetrics("tok", LOCATION, { start: "2026-11-08", end: "2026-11-09" }),
    ).rejects.toMatchObject({ code: "GBP_LISTING_METRICS_FETCH_FAILED" });
  });
});

describe("parseListingMetrics", () => {
  const range = { start: "2026-11-01", end: "2026-11-09" };

  it("adds desktop and mobile into Search and Maps views and reads each count", () => {
    const days = parseListingMetrics(
      answer({
        BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [["2026-11-08", "3"]],
        BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [["2026-11-08", "4"]],
        BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [["2026-11-08", "5"]],
        BUSINESS_IMPRESSIONS_MOBILE_MAPS: [["2026-11-08", "6"]],
        CALL_CLICKS: [["2026-11-08", "2"]],
        BUSINESS_DIRECTION_REQUESTS: [["2026-11-08", "7"]],
        WEBSITE_CLICKS: [["2026-11-08", "8"]],
      }),
      range,
    );
    expect(days).toEqual([
      { day: "2026-11-08", searchViews: 7, mapsViews: 11, calls: 2, directionRequests: 7, websiteClicks: 8 },
    ]);
  });

  it("reads a day with no value as zero (Google leaves out zeros)", () => {
    const days = parseListingMetrics(answer({ CALL_CLICKS: [["2026-11-07", undefined], ["2026-11-08", "2"]] }), range);
    expect(days.map((d) => [d.day, d.calls])).toEqual([
      ["2026-11-07", 0],
      ["2026-11-08", 2],
    ]);
  });

  it("reads a metric missing from the answer as zero", () => {
    const [day] = parseListingMetrics(answer({ CALL_CLICKS: [["2026-11-08", "2"]] }), range);
    expect(day).toEqual({ day: "2026-11-08", searchViews: 0, mapsViews: 0, calls: 2, directionRequests: 0, websiteClicks: 0 });
  });

  it("reads values that arrive as strings or numbers, and ignores ones that are not counts", () => {
    const [day] = parseListingMetrics(
      answer({ CALL_CLICKS: [["2026-11-08", "12"]], WEBSITE_CLICKS: [["2026-11-08", 3]], BUSINESS_DIRECTION_REQUESTS: [["2026-11-08", "x"]] }),
      range,
    );
    expect(day).toMatchObject({ calls: 12, websiteClicks: 3, directionRequests: 0 });
  });

  it("fills the days between the first and last day Google answered, and invents none outside", () => {
    const days = parseListingMetrics(answer({ CALL_CLICKS: [["2026-11-05", "1"], ["2026-11-07", "1"]] }), range);
    expect(days.map((d) => d.day)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
  });

  it("stores nothing when Google answered no day", () => {
    expect(parseListingMetrics({}, range)).toEqual([]);
    expect(parseListingMetrics(answer({ CALL_CLICKS: [] }), range)).toEqual([]);
  });

  it("ignores days outside the range asked for and month-only dates", () => {
    const body = answer({ CALL_CLICKS: [["2026-10-20", "9"], ["2026-11-08", "1"]] });
    body.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[0].timeSeries.datedValues.push({
      date: { year: 2026, month: 11 } as never,
      value: "50",
    });
    expect(parseListingMetrics(body, range).map((d) => [d.day, d.calls])).toEqual([["2026-11-08", 1]]);
  });
});

describe("saveListingMetricsCheckedAt", () => {
  it("merges the check time and its location onto the metadata as it is now", async () => {
    db.connectionFindUnique.mockResolvedValue({ metadata: { locationName: LOCATION, reviewsCheckedAt: "x" } });
    await expect(saveListingMetricsCheckedAt("conn-1", LOCATION, NOW)).resolves.toBe(true);
    expect(db.connectionUpdate).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        metadata: {
          locationName: LOCATION,
          reviewsCheckedAt: "x",
          listingMetricsCheckedAt: NOW.toISOString(),
          listingMetricsCheckedFor: LOCATION,
        },
      },
    });
  });

  it("writes nothing when another location was chosen meanwhile, or the connection is gone", async () => {
    db.connectionFindUnique.mockResolvedValueOnce({ metadata: { locationName: OTHER_LOCATION } });
    await expect(saveListingMetricsCheckedAt("conn-1", LOCATION, NOW)).resolves.toBe(false);
    db.connectionFindUnique.mockResolvedValueOnce(null);
    await expect(saveListingMetricsCheckedAt("conn-1", LOCATION, NOW)).resolves.toBe(false);
    expect(db.connectionUpdate).not.toHaveBeenCalled();
  });
});

describe("syncListingMetrics", () => {
  it("upserts one row per day keyed by workspace, location and day", async () => {
    useRows([conn()]);
    fetchMock.mockResolvedValue(okResponse(answer({ CALL_CLICKS: [["2026-11-08", "2"], ["2026-11-09", "3"]] })));

    const result = await syncListingMetrics(NOW, () => 0);

    expect(result).toEqual({ connections: 1, checked: 1, skipped: 0, failed: 0, left: 0, days: 2 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.metricUpsert).toHaveBeenCalledTimes(2);
    expect(db.metricUpsert.mock.calls[0][0]).toEqual({
      where: {
        workspaceId_locationName_day: { workspaceId: "ws-1", locationName: LOCATION, day: new Date("2026-11-08T00:00:00.000Z") },
      },
      create: {
        workspaceId: "ws-1",
        locationName: LOCATION,
        day: new Date("2026-11-08T00:00:00.000Z"),
        searchViews: 0,
        mapsViews: 0,
        calls: 2,
        directionRequests: 0,
        websiteClicks: 0,
        fetchedAt: NOW,
      },
      update: { searchViews: 0, mapsViews: 0, calls: 2, directionRequests: 0, websiteClicks: 0, fetchedAt: NOW },
    });
  });

  it("writes the same rows again on a second run, never adding to them", async () => {
    useRows([conn()]);
    fetchMock.mockResolvedValue(okResponse(answer({ CALL_CLICKS: [["2026-11-09", "3"]] })));

    await syncListingMetrics(NOW, () => 0);
    await syncListingMetrics(NOW, () => 0);

    const [first, second] = db.metricUpsert.mock.calls.map((call) => call[0]);
    expect(second).toEqual(first);
    // An absolute value, not an increment.
    expect(first.update.calls).toBe(3);
  });

  it("asks for ten days once the listing has rows, and ninety the first time", async () => {
    useRows([conn()]);
    await syncListingMetrics(NOW, () => 0);
    let url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("dailyRange.start_date.day")).toBe("31");

    fetchMock.mockClear();
    db.metricFindFirst.mockResolvedValue(null);
    await syncListingMetrics(NOW, () => 0);
    url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("dailyRange.start_date.month")).toBe("8");
    expect(url.searchParams.get("dailyRange.start_date.day")).toBe("12");
    expect(db.metricFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", locationName: LOCATION },
      select: { id: true },
    });
  });

  it("after a change of listing, reads the new one's history from scratch and leaves the old rows alone", async () => {
    useRows([conn({ metadata: { locationName: OTHER_LOCATION } })]);
    db.metricFindFirst.mockImplementation(async ({ where }: { where: { locationName: string } }) =>
      where.locationName === LOCATION ? { id: "old" } : null,
    );

    await syncListingMetrics(NOW, () => 0);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toContain("/locations/99:");
    expect(url.searchParams.get("dailyRange.start_date.month")).toBe("8");
    expect(db.metricDeleteMany).not.toHaveBeenCalled();
    expect(db.metricUpsert.mock.calls[0][0].where.workspaceId_locationName_day.locationName).toBe(OTHER_LOCATION);
  });

  it("skips a connection that needs reconnecting, has no location or is gone, and checks the rest", async () => {
    useRows([
      conn({ id: "c-reconnect", needsReconnect: true }),
      conn({ id: "c-none", metadata: {} }),
      conn({ id: "c-ok", workspaceId: "ws-2" }),
    ]);
    db.connectionFindMany.mockResolvedValue([
      { id: "c-reconnect", metadata: {} },
      { id: "c-none", metadata: {} },
      { id: "c-gone", metadata: {} },
      { id: "c-ok", metadata: {} },
    ]);

    const result = await syncListingMetrics(NOW, () => 0);

    expect(result).toMatchObject({ connections: 4, checked: 1, skipped: 3, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.metricUpsert.mock.calls[0][0].create.workspaceId).toBe("ws-2");
  });

  it("logs a failed connection without its location, stamps it, and carries on", async () => {
    useRows([conn({ id: "c-bad" }), conn({ id: "c-ok", workspaceId: "ws-2" })]);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Err", text: async () => "", json: async () => ({}) })
      .mockResolvedValueOnce(okResponse(answer({ CALL_CLICKS: [["2026-11-09", "1"]] })));

    const result = await syncListingMetrics(NOW, () => 0);

    expect(result).toMatchObject({ checked: 2, failed: 1, days: 1 });
    const logged = JSON.stringify(loggerMock.warn.mock.calls);
    expect(logged).toContain("c-bad");
    expect(logged).not.toContain("locations/22");
    expect(logged).not.toContain("Surf Co");
    // Both stamped: a connection that keeps failing goes behind the others.
    expect(db.connectionUpdate).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired token through the saved-token path", async () => {
    useRows([conn({ expiresAt: new Date(NOW.getTime() - 1) })]);
    refreshMock.mockResolvedValue({ accessToken: "fresh" });

    await syncListingMetrics(NOW, () => 0);

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh");
  });

  it("goes never-checked first, then oldest-checked first", async () => {
    const rows = [
      conn({ id: "c-new", metadata: { locationName: LOCATION, listingMetricsCheckedAt: "2026-11-09T09:30:00.000Z" } }),
      conn({ id: "c-never", metadata: { locationName: LOCATION } }),
      conn({ id: "c-old", metadata: { locationName: LOCATION, listingMetricsCheckedAt: "2026-11-01T09:30:00.000Z" } }),
    ];
    useRows(rows);

    await syncListingMetrics(NOW, () => 0);

    const order = db.connectionFindUnique.mock.calls
      .map((call) => call[0])
      .filter((args) => !args.select)
      .map((args) => args.where.id);
    expect(order).toEqual(["c-never", "c-old", "c-new"]);
  });

  it("starts no new connection after the 120-second budget and counts the rest as left", async () => {
    useRows([conn({ id: "a" }), conn({ id: "b" }), conn({ id: "c" })]);
    let t = 0;
    fetchMock.mockImplementation(async () => {
      t += LISTING_METRICS_BUDGET_MS + 1;
      return okResponse(answer({ CALL_CLICKS: [["2026-11-09", "1"]] }));
    });

    const result = await syncListingMetrics(NOW, () => t);

    expect(LISTING_METRICS_BUDGET_MS).toBe(120_000);
    expect(result).toMatchObject({ checked: 1, left: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns counts only", async () => {
    useRows([conn()]);
    const result = await syncListingMetrics(NOW, () => 0);
    expect(Object.values(result).every((value) => typeof value === "number")).toBe(true);
  });
});
