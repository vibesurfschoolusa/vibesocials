import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { fetchPinterestPinMetricsBatch, pinAnalyticsRange } from "./pinterestMetrics";

const fetchMock = vi.fn();
const NOW = new Date("2026-11-10T10:45:00.000Z");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answer = (summary: Record<string, unknown>) =>
  new Response(JSON.stringify({ all: { summary_metrics: summary, daily_metrics: [] } }), { status: 200 });

const pin = (id: string, publishedAt = new Date("2026-11-01T08:00:00.000Z")) => ({ id, publishedAt });

describe("pinAnalyticsRange", () => {
  it("runs from the publish day to today, never more than 89 days back", () => {
    expect(pinAnalyticsRange(new Date("2026-11-01T08:00:00.000Z"), NOW)).toEqual({
      start: "2026-11-01",
      end: "2026-11-10",
    });
    expect(pinAnalyticsRange(new Date("2026-01-01T00:00:00.000Z"), NOW)).toEqual({
      start: "2026-08-13",
      end: "2026-11-10",
    });
    // A publish time after "now" (clock skew) still asks for today.
    expect(pinAnalyticsRange(new Date("2026-11-11T00:00:00.000Z"), NOW)).toEqual({
      start: "2026-11-10",
      end: "2026-11-10",
    });
  });
});

describe("fetchPinterestPinMetricsBatch", () => {
  it("asks nothing for no pins", async () => {
    const out = await fetchPinterestPinMetricsBatch([], "t", NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.byId.size).toBe(0);
  });

  it("reads one Pin's impressions, saves and pin clicks", async () => {
    fetchMock.mockResolvedValueOnce(answer({ IMPRESSION: 240, SAVE: 20, PIN_CLICK: 37, OUTBOUND_CLICK: 5, SAVE_RATE: 0.18 }));
    const out = await fetchPinterestPinMetricsBatch([pin("123")], "pin-token", NOW);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.pinterest.com/v5/pins/123/analytics?start_date=2026-11-01&end_date=2026-11-10" +
        "&metric_types=IMPRESSION%2CSAVE%2CPIN_CLICK%2COUTBOUND_CLICK",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pin-token");
    expect(out.byId.get("123")?.counts).toEqual({
      views: 240,
      likes: null,
      comments: null,
      shares: null,
      clicks: 37,
      saves: 20,
    });
    expect(out.byId.get("123")?.asked).toEqual(["views", "saves", "clicks"]);
    expect(out.byId.get("123")?.raw).toEqual({ IMPRESSION: 240, SAVE: 20, PIN_CLICK: 37, OUTBOUND_CLICK: 5 });
  });

  it("asks once per Pin (the several-Pins endpoint is in beta), reads string counts, keeps missing ones null", async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ IMPRESSION: "12" }))
      .mockResolvedValueOnce(answer({ IMPRESSION: 3, SAVE: 1, PIN_CLICK: 0 }));
    const out = await fetchPinterestPinMetricsBatch([pin("1"), pin("2")], "t", NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.byId.get("1")?.counts).toMatchObject({ views: 12, saves: null, clicks: null });
    expect(out.byId.get("2")?.counts).toMatchObject({ views: 3, saves: 1, clicks: 0 });
  });

  it("a deleted Pin (404) is not found; another error fails that Pin only; a timeout never throws", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("slow"), { code: FETCH_TIMEOUT_CODE }))
      .mockResolvedValueOnce(answer({ IMPRESSION: 1 }));
    const out = await fetchPinterestPinMetricsBatch([pin("1"), pin("2"), pin("3"), pin("4")], "t", NOW);
    expect(out.byId.has("1")).toBe(false);
    expect(out.failed.has("1")).toBe(false);
    expect([...out.failed].sort()).toEqual(["2", "3"]);
    expect(out.byId.get("4")?.counts.views).toBe(1);
  });

  it("a 429 stops the batch; the Pins not asked about are unchecked", async () => {
    fetchMock.mockResolvedValueOnce(answer({ IMPRESSION: 1 })).mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const out = await fetchPinterestPinMetricsBatch([pin("1"), pin("2"), pin("3")], "t", NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.rateLimited).toBe(true);
    expect([...out.unchecked].sort()).toEqual(["2", "3"]);
  });

  it("stops before the next Pin when told to; those Pins are unchecked", async () => {
    fetchMock.mockResolvedValue(answer({ IMPRESSION: 1 }));
    let calls = 0;
    const out = await fetchPinterestPinMetricsBatch([pin("1"), pin("2")], "t", NOW, () => calls++ >= 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...out.unchecked]).toEqual(["2"]);
  });

  it("an answer without the Pin's metrics is not found", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const out = await fetchPinterestPinMetricsBatch([pin("1")], "t", NOW);
    expect(out.byId.size + out.failed.size).toBe(0);
  });
});
