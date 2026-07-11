import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchYouTubeVideoStatistics,
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
