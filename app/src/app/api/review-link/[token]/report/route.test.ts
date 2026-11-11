import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveReviewLinkMock, buildMonthlyReportMock, checkRateLimitMock } = vi.hoisted(() => ({
  findActiveReviewLinkMock: vi.fn(),
  buildMonthlyReportMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/server/reviewLink", () => ({ findActiveReviewLink: findActiveReviewLinkMock }));
vi.mock("@/server/reports/monthlyReport", () => ({ buildMonthlyReport: buildMonthlyReportMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { REPORT_MONTH_INVALID_MESSAGE } from "@/lib/monthlyReport";
import { REVIEW_LINK_INACTIVE_MESSAGE, REVIEW_LINK_IP_LIMIT_MESSAGE, REVIEW_LINK_IP_PER_HOUR } from "@/lib/reviewLink";

import { GET } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" };

function report() {
  return {
    month: "2026-10",
    workspaceName: "Surf Co",
    // The logo's path names its workspace (logos/<workspaceId>/, brief 18b): a
    // different id here, so the leak checks below still see the other fields.
    logoUrl: "https://abc.public.blob.vercel-storage.com/logos/ws-9/0123456789abcdef.png",
    inProgress: false,
    postCount: 1,
    posts: [
      {
        publishedAt: "2026-10-12T10:00:00.000Z",
        caption: "Dawn patrol",
        media: { url: "https://blob.example/a.jpg", mimeType: "image/jpeg" },
        mediaCount: 1,
        platforms: [{ platform: "Instagram", story: false, url: null, numbers: { likes: 3 } }],
      },
    ],
    totals: {
      resultsByPlatform: [{ platform: "Instagram", count: 1 }],
      numbers: [{ key: "likes", label: "Likes", sum: 3, posts: 1 }],
    },
    listing: {
      daysCovered: 30,
      daysCounted: 31,
      partial: false,
      totals: { views: 1, calls: 1, directionRequests: 1, websiteClicks: 1 },
      previous: null,
    },
    failed: [{ platform: "X", count: 1 }],
  };
}

function call(token = TOKEN, query = "?month=2026-10", ip = "203.0.113.7") {
  return GET(
    new Request(`http://localhost/api/review-link/${token}/report${query}`, {
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
    }),
    { params: Promise.resolve({ token }) },
  );
}

/** Every key path of a JSON value, arrays collapsed to "[]". */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => [`${prefix}.${key}`, ...keyPaths(v, `${prefix}.${key}`)]);
  }
  return [];
}

beforeEach(() => {
  findActiveReviewLinkMock.mockReset();
  buildMonthlyReportMock.mockReset();
  checkRateLimitMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findActiveReviewLinkMock.mockResolvedValue(LINK);
  buildMonthlyReportMock.mockResolvedValue(report());
});

describe("GET /api/review-link/[token]/report", () => {
  it("answers the link's workspace's report, uncached", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(report());
    expect(findActiveReviewLinkMock).toHaveBeenCalledWith(TOKEN);
    expect(buildMonthlyReportMock).toHaveBeenCalledWith("ws-1", "2026-10", expect.any(Date));
  });

  it("takes the workspace only from the link, never from the address", async () => {
    await call(TOKEN, "?month=2026-10&workspaceId=ws-2&workspace=ws-2");
    expect(buildMonthlyReportMock).toHaveBeenCalledWith("ws-1", "2026-10", expect.any(Date));
  });

  it("sends only the documented fields", async () => {
    buildMonthlyReportMock.mockResolvedValue({
      ...report(),
      workspaceId: "ws-1",
      linkId: "link-1",
      posts: report().posts.map((post) => ({ ...post, id: "post-1", errorMessage: "token expired" })),
    });

    const body = await (await call()).json();
    const text = JSON.stringify(body);
    for (const word of ["ws-1", "link-1", "post-1", "token expired", TOKEN]) expect(text).not.toContain(word);
    expect(Array.from(new Set(keyPaths(body))).sort()).toEqual(
      [
        ".month",
        ".workspaceName",
        ".logoUrl",
        ".inProgress",
        ".postCount",
        ".posts",
        ".posts[].publishedAt",
        ".posts[].caption",
        ".posts[].media",
        ".posts[].media.url",
        ".posts[].media.mimeType",
        ".posts[].mediaCount",
        ".posts[].platforms",
        ".posts[].platforms[].platform",
        ".posts[].platforms[].story",
        ".posts[].platforms[].url",
        ".posts[].platforms[].numbers",
        ".posts[].platforms[].numbers.likes",
        ".totals",
        ".totals.resultsByPlatform",
        ".totals.resultsByPlatform[].platform",
        ".totals.resultsByPlatform[].count",
        ".totals.numbers",
        ".totals.numbers[].key",
        ".totals.numbers[].label",
        ".totals.numbers[].sum",
        ".totals.numbers[].posts",
        ".listing",
        ".listing.daysCovered",
        ".listing.daysCounted",
        ".listing.partial",
        ".listing.totals",
        ".listing.totals.views",
        ".listing.totals.calls",
        ".listing.totals.directionRequests",
        ".listing.totals.websiteClicks",
        ".listing.previous",
        ".failed",
        ".failed[].platform",
        ".failed[].count",
      ].sort(),
    );
  });

  it("answers an unknown and a revoked link identically", async () => {
    // findActiveReviewLink gives null for both (src/server/reviewLink.test.ts).
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await call("unknown");
    const revoked = await call(TOKEN);

    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: REVIEW_LINK_INACTIVE_MESSAGE });
    expect(await revoked.json()).toEqual({ error: REVIEW_LINK_INACTIVE_MESSAGE });
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("shares the review routes' per-IP limit and fails closed, before the lookup", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const response = await call();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect((await response.json()).error).toBe(REVIEW_LINK_IP_LIMIT_MESSAGE);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "ip:203.0.113.7",
      route: "review-link/ip",
      limit: REVIEW_LINK_IP_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
    expect(findActiveReviewLinkMock).not.toHaveBeenCalled();
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("refuses a month outside the list", async () => {
    for (const query of ["?month=2030-01", "?month=bad", "?month=2020-01"]) {
      const response = await call(TOKEN, query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ error: REPORT_MONTH_INVALID_MESSAGE });
    }
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("says plainly when the report could not be built, with no error detail", async () => {
    buildMonthlyReportMock.mockRejectedValue(new Error("connection refused at 10.0.0.5"));
    const response = await call();
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("10.0.0.5");
    expect(text).toContain("Try again");
  });
});
