import { beforeEach, describe, expect, it, vi } from "vitest";

// The daily post numbers sync for Instagram, Facebook, LinkedIn and Pinterest.
// vi.mock is hoisted: no database, platform or token endpoint is reached.
const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  executeRaw: vi.fn(),
  instagram: vi.fn(),
  facebook: vi.fn(),
  linkedin: vi.fn(),
  pinterest: vi.fn(),
  freshLinkedIn: vi.fn(),
  freshPinterest: vi.fn(),
  freshInstagram: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { findMany: m.findMany },
    socialConnection: { findUnique: m.findUnique },
    postMetric: { upsert: m.upsert },
    $executeRaw: m.executeRaw,
  },
}));
vi.mock("@/server/platforms/instagramMetrics", () => ({
  INSTAGRAM_METRICS_IDS_PER_BATCH: 50,
  fetchInstagramMediaMetricsBatch: m.instagram,
}));
vi.mock("@/server/platforms/facebookMetrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/facebookMetrics")>()),
  fetchFacebookPostMetricsBatch: m.facebook,
}));
vi.mock("@/server/platforms/linkedinMetrics", () => ({
  LINKEDIN_URNS_PER_REQUEST: 20,
  fetchLinkedInShareStatisticsBatch: m.linkedin,
}));
vi.mock("@/server/platforms/pinterestMetrics", () => ({ fetchPinterestPinMetricsBatch: m.pinterest }));
vi.mock("@/server/platforms/linkedinClient", () => ({ ensureFreshLinkedInToken: m.freshLinkedIn }));
vi.mock("@/server/platforms/pinterestClient", () => ({ ensureFreshPinterestToken: m.freshPinterest }));
vi.mock("@/server/platforms/instagramClient", () => ({ ensureFreshInstagramToken: m.freshInstagram }));

import {
  SOCIAL_METRICS_BUDGET_MS,
  SOCIAL_METRICS_MAX_AGE_MS,
  SOCIAL_METRICS_MIN_REFRESH_MS,
  selectSocialMetricEligibleResults,
  syncSocialPostMetrics,
} from "./socialMetricsSync";

const NOW = new Date("2026-11-10T10:45:00.000Z");
type Platform = "instagram" | "facebook_page" | "linkedin" | "pinterest";

/** A result row as the selector's findMany returns it. */
function row(id: string, platform: Platform, externalPostId: string, opts: Partial<{ connection: string | null; workspace: string; mime: string }> = {}) {
  return {
    id,
    platform,
    externalPostId,
    socialConnectionId: opts.connection === undefined ? `conn-${platform}` : opts.connection,
    updatedAt: new Date("2026-11-05T09:00:00.000Z"),
    postJob: { workspaceId: opts.workspace ?? "ws-1", mediaItem: { mimeType: opts.mime ?? "image/jpeg" } },
  };
}

function connection(id: string, platform: Platform, over: Record<string, unknown> = {}) {
  return {
    id,
    platform,
    workspaceId: "ws-1",
    userId: `connector-${platform}`,
    accessToken: `token-${id}`,
    refreshToken: null,
    expiresAt: null,
    needsReconnect: false,
    metadata: platform === "linkedin" ? { organizations: [{ id: "42", name: "Surf Co" }] } : {},
    ...over,
  };
}

const counts = (over: Record<string, number | null> = {}) => ({
  views: null,
  likes: 5,
  comments: 1,
  shares: null,
  clicks: null,
  saves: null,
  ...over,
});

/** A batch result where every asked id is found. */
function allFound(ids: string[], c = counts()) {
  return {
    byId: new Map(ids.map((id) => [id, { counts: c, raw: { like_count: c.likes ?? 0 } }])),
    failed: new Set<string>(),
    unchecked: new Set<string>(),
    rateLimited: false,
  };
}

const stamped = (): string[] => m.executeRaw.mock.calls.flatMap((call) => call[2] as string[]);

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const platform = where.id.replace("conn-", "") as Platform;
    return connection(where.id, platform);
  });
  m.freshLinkedIn.mockImplementation(async (c: unknown) => c);
  m.freshPinterest.mockImplementation(async (c: unknown) => c);
  m.freshInstagram.mockImplementation((c: unknown) => c);
  m.instagram.mockImplementation(async (ids: string[]) => allFound(ids));
  m.facebook.mockImplementation(async (refs: Array<{ id: string }>) => allFound(refs.map((r) => r.id)));
  m.linkedin.mockImplementation(async (_org: string, urns: string[]) => allFound(urns));
  m.pinterest.mockImplementation(async (pins: Array<{ id: string }>) => allFound(pins.map((p) => p.id)));
  m.upsert.mockResolvedValue({});
  m.executeRaw.mockResolvedValue(1);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("selectSocialMetricEligibleResults", () => {
  it("asks for successful results with an id on the four platforms, published within 60 days, not checked in 20 hours, least recently checked first", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1"), { ...row("r2", "linkedin", "x"), externalPostId: null }]);
    const rows = await selectSocialMetricEligibleResults(NOW);

    const args = m.findMany.mock.calls[0][0];
    expect(args.where.platform).toEqual({ in: ["instagram", "facebook_page", "linkedin", "pinterest"] });
    expect(args.where.status).toBe("success");
    expect(args.where.externalPostId).toEqual({ not: null });
    expect(args.where.updatedAt).toEqual({ gte: new Date(NOW.getTime() - SOCIAL_METRICS_MAX_AGE_MS) });
    expect(args.where.OR).toEqual([
      { metricsCheckedAt: null },
      { metricsCheckedAt: { lt: new Date(NOW.getTime() - SOCIAL_METRICS_MIN_REFRESH_MS) } },
    ]);
    expect(args.orderBy[0]).toEqual({ metricsCheckedAt: { sort: "asc", nulls: "first" } });
    expect(SOCIAL_METRICS_MAX_AGE_MS).toBe(60 * 86_400_000);
    expect(SOCIAL_METRICS_MIN_REFRESH_MS).toBe(20 * 3_600_000);

    expect(rows).toEqual([
      {
        resultId: "r1",
        platform: "instagram",
        externalPostId: "m1",
        socialConnectionId: "conn-instagram",
        workspaceId: "ws-1",
        publishedAt: new Date("2026-11-05T09:00:00.000Z"),
        isVideo: false,
      },
    ]);
  });
});

describe("syncSocialPostMetrics", () => {
  it("reads each connection once, writes every platform's numbers, stamps every result, and returns counts only", async () => {
    m.findMany.mockResolvedValue([
      row("r1", "instagram", "m1"),
      row("r2", "facebook_page", "9_1"),
      row("r3", "instagram", "m2"),
      row("r4", "linkedin", "urn:li:share:1"),
      row("r5", "pinterest", "555"),
    ]);
    const out = await syncSocialPostMetrics(NOW);

    expect(m.findUnique).toHaveBeenCalledTimes(4);
    expect(m.instagram).toHaveBeenCalledTimes(1);
    expect(m.instagram.mock.calls[0]).toEqual([["m1", "m2"], "token-conn-instagram"]);
    expect(m.facebook.mock.calls[0][0]).toEqual([{ id: "9_1", kind: "post" }]);
    expect(m.linkedin.mock.calls[0]).toEqual(["urn:li:organization:42", ["urn:li:share:1"], "token-conn-linkedin"]);
    expect(m.pinterest.mock.calls[0][0]).toEqual([{ id: "555", publishedAt: new Date("2026-11-05T09:00:00.000Z") }]);
    expect(m.upsert).toHaveBeenCalledTimes(5);
    expect(stamped().sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(m.executeRaw).toHaveBeenCalledTimes(1);

    expect(out).toEqual({
      selected: 5,
      attempted: 5,
      updated: 5,
      notFound: 0,
      errors: 0,
      skippedConnections: 0,
      left: 0,
      rateLimitedPlatforms: 0,
    });
    expect(JSON.stringify(out)).not.toMatch(/token|m1|urn|conn/);
  });

  it("writes the row with the result's workspace and the connector, every column, nulls kept", async () => {
    m.findMany.mockResolvedValue([row("r1", "pinterest", "555", { workspace: "ws-1" })]);
    m.pinterest.mockResolvedValue(allFound(["555"], counts({ views: 240, likes: null, comments: null, clicks: 37, saves: 20 })));

    await syncSocialPostMetrics(NOW);

    const call = m.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ platform_externalPostId: { platform: "pinterest", externalPostId: "555" } });
    expect(call.create).toMatchObject({
      userId: "connector-pinterest",
      workspaceId: "ws-1",
      platform: "pinterest",
      externalPostId: "555",
      postJobResultId: "r1",
      views: 240,
      likes: null,
      comments: null,
      shares: null,
      clicks: 37,
      saves: 20,
      fetchedAt: NOW,
    });
    expect(call.update).toMatchObject({ views: 240, likes: null, clicks: 37, saves: 20, fetchedAt: NOW });
    expect(call.update.workspaceId).toBeUndefined();
  });

  it("a repeated run rewrites the same rows (upsert on platform and post id)", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1")]);
    await syncSocialPostMetrics(NOW);
    await syncSocialPostMetrics(NOW);
    const keys = m.upsert.mock.calls.map((call) => JSON.stringify(call[0].where));
    expect(new Set(keys).size).toBe(1);
    expect(m.upsert).toHaveBeenCalledTimes(2);
  });

  it("never writes from a connection of another workspace: those results are skipped and stamped", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1", { workspace: "ws-2" })]);
    const out = await syncSocialPostMetrics(NOW);
    expect(m.instagram).not.toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
    expect(out.skippedConnections).toBe(1);
    expect(stamped()).toEqual(["r1"]);
  });

  it("skips a connection that is gone, needs reconnecting, or whose result has none; stamps their results", async () => {
    m.findMany.mockResolvedValue([
      row("r1", "instagram", "m1"),
      row("r2", "facebook_page", "9_1"),
      row("r3", "linkedin", "urn:li:share:1", { connection: null }),
      row("r4", "pinterest", "555"),
    ]);
    m.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "conn-instagram") return null;
      if (where.id === "conn-facebook_page") return connection(where.id, "facebook_page", { needsReconnect: true });
      return connection(where.id, "pinterest");
    });

    const out = await syncSocialPostMetrics(NOW);

    expect(m.instagram).not.toHaveBeenCalled();
    expect(m.facebook).not.toHaveBeenCalled();
    expect(m.linkedin).not.toHaveBeenCalled();
    expect(m.pinterest).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ skippedConnections: 3, errors: 3, updated: 1 });
    expect(stamped().sort()).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("skips a connection whose token cannot be made usable", async () => {
    m.findMany.mockResolvedValue([row("r1", "linkedin", "urn:li:share:1"), row("r2", "instagram", "m1")]);
    m.freshLinkedIn.mockRejectedValue(Object.assign(new Error("expired"), { code: "LINKEDIN_RECONNECT_REQUIRED" }));
    m.freshInstagram.mockImplementation(() => {
      throw Object.assign(new Error("expired"), { code: "INSTAGRAM_RECONNECT_REQUIRED" });
    });
    const out = await syncSocialPostMetrics(NOW);
    expect(m.linkedin).not.toHaveBeenCalled();
    expect(m.instagram).not.toHaveBeenCalled();
    expect(out).toMatchObject({ skippedConnections: 2, errors: 2 });
  });

  it("one platform failing does not stop the others", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1"), row("r2", "pinterest", "555")]);
    m.instagram.mockRejectedValue(new Error("unexpected"));
    const out = await syncSocialPostMetrics(NOW);
    expect(m.pinterest).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ errors: 1, updated: 1 });
    expect(stamped().sort()).toEqual(["r1", "r2"]);
  });

  it("a rate limit stops that platform for the run and leaves its unchecked results unstamped", async () => {
    m.findMany.mockResolvedValue([
      row("r1", "facebook_page", "9_1"),
      row("r2", "facebook_page", "8_1", { connection: "conn-facebook_page-2" }),
      row("r3", "instagram", "m1"),
    ]);
    m.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      connection(where.id, where.id.startsWith("conn-facebook_page") ? "facebook_page" : "instagram"),
    );
    m.facebook.mockResolvedValueOnce({
      byId: new Map(),
      failed: new Set(),
      unchecked: new Set(["9_1"]),
      rateLimited: true,
    });

    const out = await syncSocialPostMetrics(NOW);

    expect(m.facebook).toHaveBeenCalledTimes(1);
    expect(m.instagram).toHaveBeenCalledTimes(1);
    expect(stamped()).toEqual(["r3"]);
    expect(out).toMatchObject({ rateLimitedPlatforms: 1, left: 2, attempted: 1 });
  });

  it("a deleted post is stamped and gets no row; a failed one is stamped as an error", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1"), row("r2", "instagram", "m2"), row("r3", "instagram", "m3")]);
    m.instagram.mockResolvedValue({
      byId: new Map([["m3", { counts: counts({ likes: null, comments: null }), raw: {} }]]),
      failed: new Set(["m2"]),
      unchecked: new Set(),
      rateLimited: false,
    });
    const out = await syncSocialPostMetrics(NOW);
    expect(m.upsert).not.toHaveBeenCalled();
    expect(out).toMatchObject({ notFound: 2, errors: 1, updated: 0, attempted: 3 });
    expect(stamped().sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("sorts Facebook ids into posts, photos and videos", async () => {
    m.findMany.mockResolvedValue([
      row("r1", "facebook_page", "9_1"),
      row("r2", "facebook_page", "100", { mime: "image/png" }),
      row("r3", "facebook_page", "200", { mime: "video/mp4" }),
    ]);
    await syncSocialPostMetrics(NOW);
    expect(m.facebook.mock.calls[0][0]).toEqual([
      { id: "9_1", kind: "post" },
      { id: "100", kind: "photo" },
      { id: "200", kind: "video" },
    ]);
  });

  it("a LinkedIn connection without a company page is skipped", async () => {
    m.findMany.mockResolvedValue([row("r1", "linkedin", "urn:li:share:1")]);
    m.findUnique.mockResolvedValue(connection("conn-linkedin", "linkedin", { metadata: {} }));
    const out = await syncSocialPostMetrics(NOW);
    expect(m.linkedin).not.toHaveBeenCalled();
    expect(out.skippedConnections).toBe(1);
  });

  it("starts no new work after 150 seconds; what it did not reach stays unstamped", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1"), row("r2", "pinterest", "555")]);
    let t = 0;
    const clock = () => t;
    m.instagram.mockImplementation(async (ids: string[]) => {
      t += SOCIAL_METRICS_BUDGET_MS + 1;
      return allFound(ids);
    });
    const out = await syncSocialPostMetrics(NOW, clock);
    expect(m.pinterest).not.toHaveBeenCalled();
    expect(stamped()).toEqual(["r1"]);
    expect(out).toMatchObject({ left: 1, attempted: 1 });
  });

  it("tells the Pinterest fetcher when the time is up", async () => {
    m.findMany.mockResolvedValue([row("r1", "pinterest", "555")]);
    let t = 0;
    await syncSocialPostMetrics(NOW, () => t);
    const shouldStop = m.pinterest.mock.calls[0][3] as () => boolean;
    expect(shouldStop()).toBe(false);
    t = SOCIAL_METRICS_BUDGET_MS + 1;
    expect(shouldStop()).toBe(true);
  });

  it("a failed write counts as an error and the rest go on", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1"), row("r2", "instagram", "m2")]);
    m.upsert.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce({});
    const out = await syncSocialPostMetrics(NOW);
    expect(out).toMatchObject({ errors: 1, updated: 1 });
  });

  it("logs no token or post id", async () => {
    m.findMany.mockResolvedValue([row("r1", "instagram", "m1-secret-id")]);
    m.instagram.mockRejectedValue(new Error("token-conn-instagram failed for m1-secret-id"));
    const spies = [console.error, console.warn, console.info, console.log] as unknown as Array<{ mock: { calls: unknown[] } }>;
    await syncSocialPostMetrics(NOW);
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    expect(logged).not.toContain("token-conn-instagram");
    expect(logged).not.toContain("m1-secret-id");
  });

  it("does nothing when nothing is eligible", async () => {
    m.findMany.mockResolvedValue([]);
    const out = await syncSocialPostMetrics(NOW);
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(out.selected).toBe(0);
  });
});
