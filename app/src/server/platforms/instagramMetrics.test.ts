import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";

import { fetchInstagramMediaMetricsBatch } from "./instagramMetrics";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function batchAnswer(entries: Array<{ code: number; body: unknown } | null>): Response {
  return new Response(
    JSON.stringify(entries.map((entry) => (entry ? { code: entry.code, body: JSON.stringify(entry.body) } : null))),
    { status: 200 },
  );
}

const sent = () =>
  fetchMock.mock.calls.map((call) =>
    JSON.parse(new URLSearchParams(String((call[1] as RequestInit).body)).get("batch") ?? "[]"),
  );

describe("fetchInstagramMediaMetricsBatch", () => {
  it("asks nothing for no ids", async () => {
    const out = await fetchInstagramMediaMetricsBatch([], "t");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.byId.size).toBe(0);
  });

  it("reads like_count and comments_count of one media in one batch request", async () => {
    fetchMock.mockResolvedValueOnce(batchAnswer([{ code: 200, body: { id: "m1", like_count: 12, comments_count: 3 } }]));
    const out = await fetchInstagramMediaMetricsBatch(["m1"], "ig-token");

    expect(fetchMock.mock.calls[0][0]).toBe(`${META_GRAPH_BASE_URL}/`);
    expect(sent()).toEqual([[{ method: "GET", relative_url: "m1?fields=like_count,comments_count" }]]);
    expect(out.byId.get("m1")?.counts).toEqual({
      views: null,
      likes: 12,
      comments: 3,
      shares: null,
      clicks: null,
      saves: null,
    });
    expect(out.byId.get("m1")?.raw).toEqual({ like_count: 12, comments_count: 3 });
    expect(out.byId.get("m1")?.asked).toEqual(["likes", "comments"]);
  });

  it("reads several ids in one request; a hidden like count stays null; a string count is read", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([
        { code: 200, body: { id: "m1", comments_count: "4" } },
        { code: 200, body: { id: "m2", like_count: "9", comments_count: 0 } },
      ]),
    );
    const out = await fetchInstagramMediaMetricsBatch(["m1", "m2"], "t");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toHaveLength(2);
    expect(out.byId.get("m1")?.counts.likes).toBeNull();
    expect(out.byId.get("m1")?.counts.comments).toBe(4);
    expect(out.byId.get("m2")?.counts.likes).toBe(9);
    expect(out.byId.get("m2")?.counts.comments).toBe(0);
  });

  it("a deleted media is not found; a whole-batch error fails all; a timeout never throws", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([{ code: 400, body: { error: { code: 100, error_subcode: 33 } } }]),
    );
    const gone = await fetchInstagramMediaMetricsBatch(["m1"], "t");
    expect(gone.byId.size + gone.failed.size + gone.unchecked.size).toBe(0);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const failed = await fetchInstagramMediaMetricsBatch(["m1", "m2"], "t");
    expect([...failed.failed].sort()).toEqual(["m1", "m2"]);

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("slow"), { code: FETCH_TIMEOUT_CODE }));
    const timedOut = await fetchInstagramMediaMetricsBatch(["m1"], "t");
    expect([...timedOut.failed]).toEqual(["m1"]);
  });

  it("an Instagram throttle (code 80002) stops the platform and leaves the item unchecked", async () => {
    fetchMock.mockResolvedValueOnce(batchAnswer([{ code: 400, body: { error: { code: 80002 } } }]));
    const out = await fetchInstagramMediaMetricsBatch(["m1"], "t");
    expect(out.rateLimited).toBe(true);
    expect([...out.unchecked]).toEqual(["m1"]);
  });
});
