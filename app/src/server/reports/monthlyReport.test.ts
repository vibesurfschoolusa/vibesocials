import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { REPORT_POST_MAX, publicMonthlyReport } from "@/lib/monthlyReport";

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

type ResultRows = Record<string, unknown>[];
let recentRows: ResultRows = [];
let failedRows: ResultRows = [];
/** The month's successes, newest first (the listed posts). */
function serveRecent(rows: ResultRows) {
  recentRows = rows;
}
/** The month's failed results, with their jobs' pair link. */
function serveFailed(rows: ResultRows) {
  failedRows = rows;
}
function recentCall() {
  const call = m.resultFindMany.mock.calls.find(([args]) => args.where.status === "success");
  if (!call) throw new Error("no successes query");
  return call[0];
}
function failedResult(platform: string, postJobId: string, storyOfPostJobId: string | null = null) {
  return { platform, postJobId, postJob: { storyOfPostJobId } };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resultFindMany.mockImplementation(async (args: { where: { status: string } }) =>
    args.where.status === "failed" ? failedRows : recentRows,
  );
  serveFailed([]);
  m.workspaceFindUnique.mockResolvedValue({ name: "Surf Co", logoUrl: "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png" });
  m.resultGroupBy.mockResolvedValue([{ platform: "instagram", status: "success", _count: { _all: 1 } }]);
  m.postCount.mockResolvedValue(1);
  serveRecent([{ postJobId: "post-1" }]);
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
    expect(grouped).toEqual({ workspaceId: WS, status: "success", updatedAt: OCT });
    expect(m.postCount.mock.calls[0][0].where).toEqual({
      workspaceId: WS,
      results: { some: { workspaceId: WS, status: "success", updatedAt: OCT } },
    });
    const recent = recentCall();
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
    expect(m.resultGroupBy.mock.calls[0][0].where.status).toBe("success");
    expect(recentCall().where.status).toBe("success");
    const failed = m.resultFindMany.mock.calls.find(([args]) => args.where.status === "failed");
    expect(failed?.[0]).toEqual({
      where: { workspaceId: WS, status: "failed", updatedAt: OCT },
      select: { platform: true, postJobId: true, postJob: { select: { storyOfPostJobId: true } } },
    });
  });

  it("drops a post row of another workspace even if one came back", async () => {
    m.postFindMany.mockResolvedValue([job(), job({ id: "post-2", workspaceId: "ws-2" })]);
    serveRecent([{ postJobId: "post-1" }, { postJobId: "post-2" }]);
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
    serveRecent(ids.flatMap((id) => [{ postJobId: id }, { postJobId: id }]));
    m.postCount.mockResolvedValue(250);
    m.postFindMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
      (args.where.id?.in ?? []).map((id) => {
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
    serveRecent([{ postJobId: "post-1" }, { postJobId: "post-2" }]);
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

  it("counts results per platform and failed posts per platform, with no detail", async () => {
    m.resultGroupBy.mockResolvedValue([
      { platform: "instagram", status: "success", _count: { _all: 3 } },
      { platform: "facebook_page", status: "success", _count: { _all: 2 } },
    ]);
    serveFailed([failedResult("instagram", "p1"), failedResult("instagram", "p2"), failedResult("x", "p2")]);
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.totals.resultsByPlatform).toEqual([
      { platform: "Instagram", count: 3 },
      { platform: "Facebook Page", count: 2 },
    ]);
    expect(report.failed).toEqual([
      { platform: "Instagram", count: 2 },
      { platform: "X", count: 1 },
    ]);
    expect(m.resultGroupBy.mock.calls[0][0].by).toEqual(["platform", "status"]);
  });

  it("counts a Feed and Story post that failed on Instagram as one post that did not publish there (R5-client-journey L2)", async () => {
    serveFailed([
      failedResult("instagram", "feed-1"),
      failedResult("instagram", "story-1", "feed-1"),
      failedResult("facebook_page", "story-1", "feed-1"),
      // A Story whose feed post went out: it did not publish, on its own.
      failedResult("instagram", "story-2", "feed-2"),
    ]);
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.failed).toEqual([
      { platform: "Instagram", count: 2 },
      { platform: "Facebook Page", count: 1 },
    ]);
  });

  it("skips the post queries when nothing succeeded in the month", async () => {
    m.postCount.mockResolvedValue(0);
    serveRecent([]);
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

// P1: the saved logo shows only where the plan includes it; the report itself is on every plan.
describe("buildMonthlyReport: the logo by plan", () => {
  const LOGO = "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png";
  const LATER = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000);
  const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };

  afterEach(() => vi.unstubAllEnvs());

  it("leaves a saved logo out on Starter, with billing on, and still builds the report", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.workspaceFindUnique.mockResolvedValue({ name: "Surf Co", logoUrl: LOGO, ...STARTER });
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.logoUrl).toBeNull();
    expect(report.postCount).toBe(1);
    expect(m.workspaceFindUnique.mock.calls[0][0].select).toMatchObject({ name: true, logoUrl: true, plan: true });
  });

  it("shows it on Growth, in a trial, for an exempt workspace and with billing off", async () => {
    for (const [billing, on] of [
      [{ ...STARTER, plan: "growth" }, true],
      [{ trialEndsAt: LATER }, true],
      [{ ...STARTER, billingExempt: true }, true],
      [STARTER, false],
    ] as const) {
      vi.stubEnv("BILLING_ENABLED", on ? "true" : "");
      m.workspaceFindUnique.mockResolvedValue({ name: "Surf Co", logoUrl: LOGO, ...billing });
      expect((await buildMonthlyReport(WS, "2026-10", NOW)).logoUrl).toBe(LOGO);
    }
  });

  it("with billing off reads only today's columns", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    await buildMonthlyReport(WS, "2026-10", NOW);
    expect(m.workspaceFindUnique.mock.calls[0][0].select).toEqual({ name: true, logoUrl: true });
  });
});

// F6: a Feed and Story post is two jobs; the report counts and lists it once.
describe("buildMonthlyReport - a Feed and Story pair", () => {
  const feedJob = () =>
    job({
      id: "feed-1",
      storyOfPostJobId: null,
      results: [result({ platform: "instagram", externalPostId: "ig-feed", updatedAt: new Date("2026-10-12T10:00:00Z") })],
    });
  const storyJob = () =>
    job({
      id: "story-1",
      storyOfPostJobId: "feed-1",
      publishMetadata: { instagram: { placement: "story" } },
      results: [
        result({
          platform: "instagram",
          externalPostId: "ig-story",
          externalPostUrl: "https://www.instagram.com/stories/x/1/",
          updatedAt: new Date("2026-10-12T10:01:00Z"),
        }),
      ],
    });

  beforeEach(() => {
    m.postCount.mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? 1 : 2));
    serveRecent([{ postJobId: "story-1" }, { postJobId: "feed-1" }]);
    m.postFindMany.mockImplementation(async (args: { where: { id?: { in: string[] }; storyOfPostJobId?: unknown } }) =>
      args.where.storyOfPostJobId ? [{ storyOfPostJobId: "feed-1" }] : [storyJob(), feedJob()],
    );
  });

  it("counts the pair as one post", async () => {
    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.postCount).toBe(1);
    // The Story jobs that published in the month, then their feed posts that did too.
    const storyQuery = m.postFindMany.mock.calls.find((c) => c[0].where.storyOfPostJobId)![0];
    expect(storyQuery).toEqual({
      where: {
        workspaceId: WS,
        storyOfPostJobId: { not: null },
        results: { some: { workspaceId: WS, status: "success", updatedAt: OCT } },
      },
      select: { storyOfPostJobId: true },
    });
    expect(m.postCount.mock.calls[1][0].where).toEqual({
      workspaceId: WS,
      id: { in: ["feed-1"] },
      results: { some: { workspaceId: WS, status: "success", updatedAt: OCT } },
    });
  });

  it("lists the pair once, with the feed and the Story platforms, at the later time", async () => {
    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.posts).toHaveLength(1);
    expect(report.posts[0].publishedAt).toBe("2026-10-12T10:01:00.000Z");
    expect(report.posts[0].platforms).toEqual([
      expect.objectContaining({ platform: "Instagram", story: false }),
      expect.objectContaining({ platform: "Instagram", story: true, url: "https://www.instagram.com/stories/x/1/" }),
    ]);
  });

  it("tags the joined pair Feed and Story, from the link", async () => {
    const report = await buildMonthlyReport(WS, "2026-10", NOW);
    expect(report.posts[0].feedAndStory).toBe(true);
  });

  it("tags a pair whose Instagram feed failed but whose Instagram Story and Facebook feed went out", async () => {
    m.postFindMany.mockImplementation(async (args: { where: { storyOfPostJobId?: unknown } }) =>
      args.where.storyOfPostJobId
        ? [{ storyOfPostJobId: "feed-1" }]
        : [
            storyJob(),
            job({
              id: "feed-1",
              storyOfPostJobId: null,
              results: [
                result({ platform: "instagram", status: "failed", externalPostId: null, externalPostUrl: null }),
                result({ platform: "facebook_page", externalPostId: "fb-feed", externalPostUrl: null }),
              ],
            }),
          ],
    );

    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.postCount).toBe(1);
    expect(report.posts).toHaveLength(1);
    expect(report.posts[0].feedAndStory).toBe(true);
    // No Instagram feed row: it did not go out. The Instagram Story and the Facebook post did.
    expect(report.posts[0].platforms.map((p) => [p.platform, p.story])).toEqual([
      ["Instagram", true],
      ["Facebook Page", false],
    ]);
  });

  it("a Story that failed everywhere leaves the feed post alone, untagged", async () => {
    m.postCount.mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? 0 : 1));
    serveRecent([{ postJobId: "feed-1" }]);
    m.postFindMany.mockImplementation(async (args: { where: { storyOfPostJobId?: unknown } }) =>
      // No Story job published in the month, so none is named.
      args.where.storyOfPostJobId ? [] : [feedJob()],
    );

    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.postCount).toBe(1);
    expect(report.posts).toHaveLength(1);
    expect(report.posts[0]).not.toHaveProperty("feedAndStory");
    expect(report.posts[0].platforms).toEqual([expect.objectContaining({ platform: "Instagram", story: false })]);
  });

  it("the client's report shows the same tags as the owner's", async () => {
    const owner = await buildMonthlyReport(WS, "2026-10", NOW);
    const client = publicMonthlyReport(owner);
    expect(client.posts.map((p) => p.feedAndStory ?? false)).toEqual(owner.posts.map((p) => p.feedAndStory ?? false));
    expect(client.posts.map((p) => p.feedAndStory ?? false)).toEqual([true]);
  });

  it("lists a Story whose feed post is gone, or did not publish this month, on its own", async () => {
    m.postCount.mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? 0 : 1));
    serveRecent([{ postJobId: "story-1" }]);
    m.postFindMany.mockImplementation(async (args: { where: { storyOfPostJobId?: unknown } }) =>
      args.where.storyOfPostJobId ? [{ storyOfPostJobId: "feed-1" }] : [storyJob()],
    );

    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.postCount).toBe(1);
    expect(report.posts).toHaveLength(1);
    expect(report.posts[0].platforms).toEqual([expect.objectContaining({ platform: "Instagram", story: true })]);
    expect(report.posts[0]).not.toHaveProperty("feedAndStory");
  });

  it("a month without Story jobs asks for no feed count", async () => {
    m.postCount.mockReset();
    m.postCount.mockResolvedValue(1);
    m.postFindMany.mockImplementation(async (args: { where: { storyOfPostJobId?: unknown } }) =>
      args.where.storyOfPostJobId ? [] : [job()],
    );

    const report = await buildMonthlyReport(WS, "2026-10", NOW);

    expect(report.postCount).toBe(1);
    expect(m.postCount).toHaveBeenCalledTimes(1);
  });
});
