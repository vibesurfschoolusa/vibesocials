import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  resultGroupBy: vi.fn(),
  resultFindMany: vi.fn(),
  postCount: vi.fn(),
  postFindMany: vi.fn(),
  mediaGroupBy: vi.fn(),
  metricFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  listingFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: m.workspaceFindUnique },
    postJobResult: { groupBy: m.resultGroupBy, findMany: m.resultFindMany },
    postJob: { count: m.postCount, findMany: m.postFindMany },
    postJobMedia: { groupBy: m.mediaGroupBy },
    postMetric: { findMany: m.metricFindMany },
    socialConnection: { findUnique: m.connectionFindUnique },
    locationMetricDaily: { findMany: m.listingFindMany },
  },
}));

import { REPORT_POST_MAX } from "@/lib/monthlyReport";

import { buildMonthlyReport } from "./monthlyReport";

const WS = "ws-1";
const NOW = new Date("2026-11-10T12:00:00Z");
const OCT = { gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") };

function result(overrides: Record<string, unknown> = {}) {
  return {
    platform: "instagram",
    status: "success",
    externalPostId: "ig-1",
    externalPostUrl: "https://www.instagram.com/p/abc/",
    updatedAt: new Date("2026-10-12T10:00:00Z"),
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    workspaceId: WS,
    baseCaption: "Dawn patrol",
    publishMetadata: null,
    mediaItem: {
      baseCaption: "media caption",
      storageLocation: "https://blob.example/a.jpg",
      mimeType: "image/jpeg",
      deletedAt: null,
    },
    results: [result()],
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.workspaceFindUnique.mockResolvedValue({ name: "Surf Co", logoUrl: "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png" });
  m.resultGroupBy.mockResolvedValue([{ platform: "instagram", status: "success", _count: { _all: 1 } }]);
  m.postCount.mockResolvedValue(1);
  m.resultFindMany.mockResolvedValue([{ postJobId: "post-1" }]);
  m.postFindMany.mockResolvedValue([job()]);
  m.mediaGroupBy.mockResolvedValue([]);
  m.metricFindMany.mockResolvedValue([]);
  m.connectionFindUnique.mockResolvedValue(null);
  m.listingFindMany.mockResolvedValue([]);
});

describe("buildMonthlyReport", () => {
  it("carries no logo when the workspace has none", async () => {
    m.workspaceFindUnique.mockResolvedValue({ name: "Surf Co", logoUrl: null });
    expect((await buildMonthlyReport(WS, "2026-10", NOW)).logoUrl).toBeNull();
  });

  it("builds the month's report from this workspace's data only", async () => {
    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report).toEqual({
      month: "2026-10",
      workspaceName: "Surf Co",
      logoUrl: "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png",
      inProgress: false,
      postCount: 1,
      posts: [
        {
          publishedAt: "2026-10-12T10:00:00.000Z",
          caption: "Dawn patrol",
          media: { url: "https://blob.example/a.jpg", mimeType: "image/jpeg" },
          mediaCount: 1,
          platforms: [
            { platform: "Instagram", story: false, url: "https://www.instagram.com/p/abc/", numbers: {} },
          ],
        },
      ],
      totals: { resultsByPlatform: [{ platform: "Instagram", count: 1 }], numbers: [] },
      listing: null,
      failed: [],
    });

    // Every query is scoped to the workspace, and the result queries to the month.
    expect(m.workspaceFindUnique.mock.calls[0][0].where).toEqual({ id: WS });
    const grouped = m.resultGroupBy.mock.calls[0][0].where;
    // The result's own (denormalised) workspace id: no join over PostJob.
    expect(grouped).toEqual({ workspaceId: WS, status: { in: ["success", "failed"] }, updatedAt: OCT });
    expect(m.postCount.mock.calls[0][0].where).toEqual({
      workspaceId: WS,
      results: { some: { workspaceId: WS, status: "success", updatedAt: OCT } },
    });
    const recent = m.resultFindMany.mock.calls[0][0];
    expect(recent.where).toEqual({
      workspaceId: WS,
      status: "success",
      updatedAt: OCT,
    });
    expect(recent.take).toBeLessThanOrEqual(REPORT_POST_MAX * 10);
    expect(m.postFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["post-1"] }, workspaceId: WS });
  });

  it("asks only for results that succeeded or failed in the month (no drafts or scheduled posts)", async () => {
    await buildMonthlyReport(WS, "2026-10", NOW);
    expect(m.resultGroupBy.mock.calls[0][0].where.status).toEqual({ in: ["success", "failed"] });
    expect(m.resultFindMany.mock.calls[0][0].where.status).toBe("success");
  });

  it("drops a post row of another workspace even if one came back", async () => {
    m.postFindMany.mockResolvedValue([job(), job({ id: "post-2", workspaceId: "ws-2" })]);
    m.resultFindMany.mockResolvedValue([{ postJobId: "post-1" }, { postJobId: "post-2" }]);
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.posts).toHaveLength(1);
  });

  it("lists a post under each month for the platform that published in it", async () => {
    m.postFindMany.mockResolvedValue([
      job({
        results: [
          result({ platform: "instagram", updatedAt: new Date("2026-10-31T23:00:00Z") }),
          result({
            platform: "facebook_page",
            externalPostId: "fb-1",
            externalPostUrl: null,
            updatedAt: new Date("2026-11-01T01:00:00Z"),
          }),
          result({ platform: "x", status: "failed", externalPostId: null, updatedAt: new Date("2026-10-20T00:00:00Z") }),
        ],
      }),
    ]);

    const october = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(october.posts[0].platforms.map((p) => p.platform)).toEqual(["Instagram"]);
    expect(october.posts[0].publishedAt).toBe("2026-10-31T23:00:00.000Z");

    const november = await buildMonthlyReport(WS, "2026-11", NOW);
    expect(november.inProgress).toBe(true);
    expect(november.posts[0].platforms.map((p) => p.platform)).toEqual(["Facebook Page"]);
    expect(november.posts[0].publishedAt).toBe("2026-11-01T01:00:00.000Z");
  });

  it("orders posts newest first and lists at most 200 distinct posts", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `post-${i}`);
    // Two results per post, newest first, as the query orders them.
    m.resultFindMany.mockResolvedValue(ids.flatMap((id) => [{ postJobId: id }, { postJobId: id }]));
    m.postCount.mockResolvedValue(250);
    m.postFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => {
        const n = Number(id.split("-")[1]);
        return job({ id, results: [result({ updatedAt: new Date(Date.UTC(2026, 9, 30, 0, 0, 0) - n * 60_000) })] });
      }),
    );

    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(m.postFindMany.mock.calls[0][0].where.id.in).toHaveLength(REPORT_POST_MAX);
    expect(report.posts).toHaveLength(REPORT_POST_MAX);
    expect(report.postCount).toBe(250);
    const times = report.posts.map((p) => p.publishedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("marks Stories and decides links as Activity does", async () => {
    m.postFindMany.mockResolvedValue([
      job({
        publishMetadata: { instagram: { placement: "story" }, facebook: { placement: "story" } },
        results: [
          // A Story with a returned link keeps it.
          result({ platform: "instagram", externalPostUrl: "https://www.instagram.com/stories/x/1/" }),
          // A Facebook Story's id does not open it: no link.
          result({ platform: "facebook_page", externalPostId: "fb-1", externalPostUrl: null }),
          // A feed post on X gets the link built from its id.
          result({ platform: "x", externalPostId: "123", externalPostUrl: null }),
          // A stored link that is not https is not used.
          result({ platform: "tiktok", externalPostId: "pub-1", externalPostUrl: "javascript:alert(1)" }),
        ],
      }),
    ]);

    const [post] = (await buildMonthlyReport(WS, "2026-10", NOW)).posts;
    // In the app's platform order.
    expect(post.platforms).toEqual([
      expect.objectContaining({ platform: "TikTok", story: false, url: null }),
      expect.objectContaining({ platform: "Instagram", story: true, url: "https://www.instagram.com/stories/x/1/" }),
      expect.objectContaining({ platform: "X", story: false, url: "https://x.com/i/web/status/123" }),
      expect.objectContaining({ platform: "Facebook Page", story: true, url: null }),
    ]);
  });

  it("gives the placeholder for a file the retention sweep removed, and the photo count", async () => {
    m.postFindMany.mockResolvedValue([
      job({
        baseCaption: null,
        mediaItem: {
          baseCaption: "from the media",
          storageLocation: "https://blob.example/gone.jpg",
          mimeType: "image/jpeg",
          deletedAt: new Date("2026-11-01T00:00:00Z"),
        },
      }),
    ]);
    m.mediaGroupBy.mockResolvedValue([{ postJobId: "post-1", _count: { _all: 4 } }]);

    const [post] = (await buildMonthlyReport(WS, "2026-10", NOW)).posts;
    expect(post.media).toBeNull();
    expect(post.mediaCount).toBe(4);
    expect(post.caption).toBe("from the media");
    expect(m.mediaGroupBy.mock.calls[0][0].where).toEqual({ postJobId: { in: ["post-1"] } });
  });

  it("joins the numbers in one query scoped to the workspace, keeps only the non-null ones, and totals them", async () => {
    m.postFindMany.mockResolvedValue([
      job({
        results: [
          result({ platform: "instagram", externalPostId: "ig-1" }),
          result({ platform: "linkedin", externalPostId: "urn:li:share:1", externalPostUrl: null }),
        ],
      }),
      job({ id: "post-2", results: [result({ platform: "instagram", externalPostId: "ig-2" })] }),
    ]);
    m.resultFindMany.mockResolvedValue([{ postJobId: "post-1" }, { postJobId: "post-2" }]);
    m.metricFindMany.mockResolvedValue([
      { workspaceId: WS, platform: "instagram", externalPostId: "ig-1", views: 100, likes: 10, comments: null, shares: null, clicks: null, saves: null },
      { workspaceId: WS, platform: "linkedin", externalPostId: "urn:li:share:1", views: null, likes: 3, comments: 0, shares: null, clicks: 7, saves: null },
      // Another workspace's row with the same id never appears.
      { workspaceId: "ws-2", platform: "instagram", externalPostId: "ig-2", views: 999, likes: 999, comments: null, shares: null, clicks: null, saves: null },
    ]);

    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(m.metricFindMany).toHaveBeenCalledTimes(1);
    const where = m.metricFindMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
    expect(where.externalPostId.in.sort()).toEqual(["ig-1", "ig-2", "urn:li:share:1"]);

    const [first, second] = report.posts;
    expect(first.platforms[0].numbers).toEqual({ views: 100, likes: 10 });
    expect(first.platforms[1].numbers).toEqual({ likes: 3, comments: 0, clicks: 7 });
    expect(second.platforms[0].numbers).toEqual({});
    expect(report.totals.numbers).toEqual([
      { key: "views", label: "Views", sum: 100, posts: 1 },
      { key: "likes", label: "Likes", sum: 13, posts: 1 },
      { key: "comments", label: "Comments", sum: 0, posts: 1 },
      { key: "clicks", label: "Clicks", sum: 7, posts: 1 },
    ]);
  });

  it("counts results per platform and failures per platform, with no detail", async () => {
    m.resultGroupBy.mockResolvedValue([
      { platform: "instagram", status: "success", _count: { _all: 3 } },
      { platform: "facebook_page", status: "success", _count: { _all: 2 } },
      { platform: "instagram", status: "failed", _count: { _all: 2 } },
    ]);
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.totals.resultsByPlatform).toEqual([
      { platform: "Instagram", count: 3 },
      { platform: "Facebook Page", count: 2 },
    ]);
    expect(report.failed).toEqual([{ platform: "Instagram", count: 2 }]);
    expect(m.resultGroupBy.mock.calls[0][0].by).toEqual(["platform", "status"]);
  });

  it("skips the post queries when nothing succeeded in the month", async () => {
    m.postCount.mockResolvedValue(0);
    m.resultFindMany.mockResolvedValue([]);
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.posts).toEqual([]);
    expect(m.postFindMany).not.toHaveBeenCalled();
    expect(m.metricFindMany).not.toHaveBeenCalled();
  });

  it("has no listing section without a chosen listing", async () => {
    m.connectionFindUnique.mockResolvedValue({ metadata: {} });
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.listing).toBeNull();
    expect(m.listingFindMany).not.toHaveBeenCalled();
    expect(m.connectionFindUnique.mock.calls[0][0].where).toEqual({
      workspaceId_platform: { workspaceId: WS, platform: "google_business_profile" },
    });
  });

  it("reads only the current listing's rows of this month and the one before", async () => {
    m.connectionFindUnique.mockResolvedValue({ metadata: { locationName: "locations/1" } });
    const row = (day: string, n: number, extra: Record<string, unknown> = {}) => ({
      workspaceId: WS,
      locationName: "locations/1",
      day: new Date(`${day}T00:00:00Z`),
      searchViews: n,
      mapsViews: n,
      calls: n,
      directionRequests: n,
      websiteClicks: n,
      ...extra,
    });
    m.listingFindMany.mockResolvedValue([
      row("2026-10-01", 2),
      row("2026-10-02", 3),
      // An earlier listing's row and another workspace's row never count.
      row("2026-10-03", 100, { locationName: "locations/old" }),
      row("2026-10-04", 100, { workspaceId: "ws-2" }),
    ]);

    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(m.listingFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: WS,
      locationName: "locations/1",
      day: { gte: new Date("2026-09-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") },
    });
    expect(report.listing).toEqual({
      daysCovered: 2,
      daysCounted: 31,
      partial: false,
      totals: { views: 10, calls: 5, directionRequests: 5, websiteClicks: 5 },
      previous: null,
    });
  });

  it("leaves the listing out when no day of the month is stored", async () => {
    m.connectionFindUnique.mockResolvedValue({ metadata: { locationName: "locations/1" } });
    m.listingFindMany.mockResolvedValue([]);
    expect((await buildMonthlyReport(WS, "2026-10", NOW)).listing).toBeNull();
  });
});

describe("buildMonthlyReport - a post without a file", () => {
  it("lists a text post with no picture and a mediaCount of 0", async () => {
    m.postFindMany.mockResolvedValue([job({ mediaItemId: null, mediaItem: null, baseCaption: "Wind is onshore" })]);

    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(m.postFindMany.mock.calls[0][0].select).toHaveProperty("mediaItemId", true);
    expect(report.posts[0]).toMatchObject({ caption: "Wind is onshore", media: null, mediaCount: 0 });
  });
});
