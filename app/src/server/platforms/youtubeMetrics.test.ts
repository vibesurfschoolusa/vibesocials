import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchYouTubeVideoStatistics,
  fetchYouTubeVideoStatisticsBatch,
  hasAnyStatistic,
  parseYouTubeStatistics,
} from "@/server/platforms/youtubeMetrics";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("hasAnyStatistic (review Minor #2/#5 upsert guard)", () => {
  it("is false when every count is null (so the cron skips the upsert, not wiping good data)", () => {
    expect(hasAnyStatistic({ views: null, likes: null, comments: null })).toBe(false);
  });

  it("is true when at least one count is present — including a real zero", () => {
    expect(hasAnyStatistic({ views: 0, likes: null, comments: null })).toBe(true);
    expect(hasAnyStatistic({ views: null, likes: 5, comments: null })).toBe(true);
    expect(hasAnyStatistic({ views: 100, likes: 2, comments: 1 })).toBe(true);
  });
})

describe("parseYouTubeStatistics", () => {
  it("parses a normal statistics payload, coercing string counts to numbers", () => {
    const response = {
      items: [
        {
          id: "vid1",
          statistics: { viewCount: "12345", likeCount: "678", commentCount: "9" },
        },
      ],
    };
    expect(parseYouTubeStatistics(response)).toEqual({
      views: 12345,
      likes: 678,
      comments: 9,
    });
  });

  it("returns null (not 0) for a hidden like count (likeCount key absent)", () => {
    const response = {
      items: [{ id: "vid1", statistics: { viewCount: "100", commentCount: "2" } }],
    };
    // likes is null (hidden), NOT 0 — hidden must be distinguishable from zero.
    expect(parseYouTubeStatistics(response)).toEqual({
      views: 100,
      likes: null,
      comments: 2,
    });
  });

  it("preserves a genuine zero count", () => {
    const response = {
      items: [
        { id: "vid1", statistics: { viewCount: "0", likeCount: "0", commentCount: "0" } },
      ],
    };
    expect(parseYouTubeStatistics(response)).toEqual({ views: 0, likes: 0, comments: 0 });
  });

  it("returns all-null for a missing item (empty items — deleted/inaccessible video)", () => {
    expect(parseYouTubeStatistics({ items: [] })).toEqual({
      views: null,
      likes: null,
      comments: null,
    });
  });

  it("returns all-null for malformed / unexpected payloads without throwing", () => {
    const allNull = { views: null, likes: null, comments: null };
    expect(parseYouTubeStatistics(null)).toEqual(allNull);
    expect(parseYouTubeStatistics(undefined)).toEqual(allNull);
    expect(parseYouTubeStatistics("nope")).toEqual(allNull);
    expect(parseYouTubeStatistics(42)).toEqual(allNull);
    expect(parseYouTubeStatistics({})).toEqual(allNull);
    expect(parseYouTubeStatistics({ items: "not-an-array" })).toEqual(allNull);
    expect(parseYouTubeStatistics({ items: [{}] })).toEqual(allNull); // no statistics
    expect(parseYouTubeStatistics({ items: [null] })).toEqual(allNull);
    // Non-numeric string count coerces to null, not NaN.
    expect(
      parseYouTubeStatistics({ items: [{ statistics: { viewCount: "abc" } }] }),
    ).toEqual(allNull);
    // Empty-string count -> null (not Number("") === 0).
    expect(
      parseYouTubeStatistics({ items: [{ statistics: { viewCount: "" } }] }),
    ).toEqual(allNull);
  });
});

describe("fetchYouTubeVideoStatistics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a Bearer-authenticated videos.list request and returns parsed stats on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ id: "vid1", statistics: { viewCount: "10", likeCount: "2", commentCount: "1" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatistics("vid1", "access-token-xyz");

    expect(result).toEqual({
      ok: true,
      found: true,
      stats: { views: 10, likes: 2, comments: 1 },
      raw: expect.objectContaining({ items: expect.any(Array) }),
    });

    // Assert the request shape: correct endpoint + part + id, Bearer auth.
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("https://www.googleapis.com/youtube/v3/videos");
    expect(calledUrl).toContain("part=statistics");
    expect(calledUrl).toContain("id=vid1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-xyz");
  });

  it("returns ok+found:false for a 200 with empty items (video gone) so the caller skips the upsert", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatistics("gone", "token");

    expect(result).toEqual({
      ok: true,
      found: false,
      stats: { views: null, likes: null, comments: null },
      raw: expect.anything(),
    });
  });

  it("returns a sanitized typed failure on a non-2xx WITHOUT leaking the upstream body", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = "quota exceeded SECRET_DETAIL_123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 403, statusText: "Forbidden" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatistics("vid1", "token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("YOUTUBE_METRICS_HTTP_ERROR");
      expect(result.error).toContain("403");
      expect(result.error).not.toContain(upstreamBody);
    }
    // Raw body still reaches server logs for debugging.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);
  });

  it("never throws on a network error — returns a typed failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatistics("vid1", "token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("YOUTUBE_METRICS_FETCH_ERROR");
    }
  });
});

describe("fetchYouTubeVideoStatisticsBatch (2026-11-01 scale audit, jobs: 50 ids per call)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function errorBody(reason: string, status: number): Response {
    return jsonResponse({ error: { code: status, errors: [{ reason, domain: "youtube.quota" }] } }, status);
  }

  it("sends ONE Bearer-authenticated videos.list request for all ids; an id missing from items is absent from byId (not found)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ id: "v1", statistics: { viewCount: "10", likeCount: "2", commentCount: "1" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatisticsBatch(["v1", "v2"], "access-token-xyz");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("statistics");
    expect(url.searchParams.get("id")).toBe("v1,v2");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-xyz");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.byId.keys()]).toEqual(["v1"]);
    expect(result.byId.get("v1")).toEqual({
      stats: { views: 10, likes: 2, comments: 1 },
      raw: { id: "v1", statistics: { viewCount: "10", likeCount: "2", commentCount: "1" } },
    });
    expect(result.byId.has("v2")).toBe(false);
  });

  it("keeps each video's own counts (a hidden like count stays null, a real zero stays 0)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [
            { id: "v1", statistics: { viewCount: "100", commentCount: "2" } },
            { id: "v2", statistics: { viewCount: "0", likeCount: "0", commentCount: "0" } },
            { id: "v3" },
          ],
        }),
      ),
    );

    const result = await fetchYouTubeVideoStatisticsBatch(["v1", "v2", "v3"], "token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byId.get("v1")?.stats).toEqual({ views: 100, likes: null, comments: 2 });
    expect(result.byId.get("v2")?.stats).toEqual({ views: 0, likes: 0, comments: 0 });
    // Present but with no statistics object: found, all-null (the caller skips the upsert).
    expect(result.byId.get("v3")?.stats).toEqual({ views: null, likes: null, comments: null });
  });

  it("ignores malformed items (no id, wrong type) instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ items: [null, "x", {}, { id: 7 }, { id: "v1", statistics: { viewCount: "1" } }] }),
      ),
    );

    const result = await fetchYouTubeVideoStatisticsBatch(["v1"], "token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.byId.keys()]).toEqual(["v1"]);
  });

  it("returns an empty map for a body without items (every id not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    const result = await fetchYouTubeVideoStatisticsBatch(["v1"], "token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byId.size).toBe(0);
  });

  it("makes no request for an empty id list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeVideoStatisticsBatch([], "token");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.byId.size).toBe(0);
  });

  it("reports a 403 quotaExceeded as quotaExceeded (the run stops), with a sanitized code", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorBody("quotaExceeded", 403)));

    const result = await fetchYouTubeVideoStatisticsBatch(["v1", "v2"], "token");

    expect(result).toEqual({ ok: false, code: "YOUTUBE_METRICS_QUOTA_EXCEEDED", quotaExceeded: true });
    // The upstream body reaches server logs only.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain("quotaExceeded");
  });

  it("treats dailyLimitExceeded (403) and a 429 rate limit as quota / rate refusals too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorBody("dailyLimitExceeded", 403)));
    expect(await fetchYouTubeVideoStatisticsBatch(["v1"], "token")).toMatchObject({
      ok: false,
      quotaExceeded: true,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    expect(await fetchYouTubeVideoStatisticsBatch(["v1"], "token")).toMatchObject({
      ok: false,
      quotaExceeded: true,
    });
  });

  it("any other non-2xx is a plain error: no quotaExceeded flag, no upstream body in the result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = "SECRET_DETAIL_123";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 500 })));
    const serverError = await fetchYouTubeVideoStatisticsBatch(["v1"], "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorBody("forbidden", 403)));
    const forbidden = await fetchYouTubeVideoStatisticsBatch(["v1"], "token");

    expect(serverError).toEqual({ ok: false, code: "YOUTUBE_METRICS_HTTP_ERROR", quotaExceeded: false });
    expect(forbidden).toEqual({ ok: false, code: "YOUTUBE_METRICS_HTTP_ERROR", quotaExceeded: false });
    expect(JSON.stringify(serverError)).not.toContain(body);
  });

  it("never throws on a network error or an unreadable 200 body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(await fetchYouTubeVideoStatisticsBatch(["v1"], "token")).toEqual({
      ok: false,
      code: "YOUTUBE_METRICS_FETCH_ERROR",
      quotaExceeded: false,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    expect(await fetchYouTubeVideoStatisticsBatch(["v1"], "token")).toEqual({
      ok: false,
      code: "YOUTUBE_METRICS_FETCH_ERROR",
      quotaExceeded: false,
    });
  });
});
