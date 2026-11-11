import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodePostsCursor, type PostsResponse } from "@/lib/postsDto";
import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// Roadmap Phase 8 — GET /api/posts metrics join. route.ts imports several
// modules at scope but GET only uses getWorkspaceContext (Team Workspaces,
// Task 4) + prisma.postJob.findMany + prisma.postMetric.findMany; the rest
// are mocked so the module loads without real side effects (mirrors
// route.test.ts, which covers POST).
const {
  getWorkspaceContextMock,
  getWorkspaceMemberCountMock,
  postJobFindManyMock,
  postMetricFindManyMock,
  postJobMediaGroupByMock,
} = vi.hoisted(() => ({
  postJobMediaGroupByMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  getWorkspaceMemberCountMock: vi.fn(),
  postJobFindManyMock: vi.fn(),
  postMetricFindManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
  getWorkspaceMemberCount: getWorkspaceMemberCountMock,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/server/jobs/posting", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/posting")>(
    "@/server/jobs/posting",
  );
  return { ...actual, createPostJobOnly: vi.fn(), createPostJobForExistingMedia: vi.fn() };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findMany: postJobFindManyMock },
    postMetric: { findMany: postMetricFindManyMock },
    postJobMedia: { groupBy: postJobMediaGroupByMock },
  },
}));

import { GET } from "./route";

function getRequest(url = "http://localhost/api/posts"): Request {
  return new Request(url, { method: "GET" });
}

/** A job whose fan-out includes a successful YouTube result + a TikTok result. */
function jobWithYouTube() {
  return {
    id: "job-1",
    status: "completed",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:05:00.123Z"),
    scheduledFor: null,
    baseCaption: "hello",
    mediaItem: {
      baseCaption: "media cap",
      storageLocation: "https://blob.example.com/media-1.mp4",
      mimeType: "video/mp4",
    },
    // Team Workspaces (Task 4) — joined creator, mapped to the DTO's
    // `createdBy` field. Has a `name`, so most tests don't exercise the
    // email-local-part fallback (see the dedicated `createdBy` block below).
    user: { name: "Alice", email: "alice@example.com" },
    // Task 8 — compose-time publish snapshot (Task 7's publishMetadata),
    // mapped onto the DTO's `publish` field.
    publishMetadata: {
      youtube: { privacyStatus: "unlisted" },
      tiktok: { privacyLevel: "SELF_ONLY" },
      targetPlatforms: ["youtube", "tiktok"],
    },
    results: [
      {
        platform: "youtube",
        status: "success",
        externalPostId: "vidA",
        errorMessage: null,
      },
      {
        platform: "tiktok",
        status: "success",
        externalPostId: "tikA",
        errorMessage: null,
      },
    ],
  };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  getWorkspaceMemberCountMock.mockReset();
  postJobFindManyMock.mockReset();
  postMetricFindManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  getWorkspaceMemberCountMock.mockResolvedValue(1);
  postJobFindManyMock.mockResolvedValue([]);
  postMetricFindManyMock.mockResolvedValue([]);
  // 07a: by default no post on the page has several photos.
  postJobMediaGroupByMock.mockReset();
  postJobMediaGroupByMock.mockResolvedValue([]);
});

describe("GET /api/posts — metrics join (Roadmap Phase 8)", () => {
  it("401s when unauthenticated and never queries", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(postJobFindManyMock).not.toHaveBeenCalled();
    expect(postMetricFindManyMock).not.toHaveBeenCalled();
  });

  it("scopes the metric query to the caller + the metric platforms + the collected post ids, selecting display fields only", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([
      {
        platform: "youtube",
        externalPostId: "vidA",
        views: 100,
        likes: 5,
        comments: 2,
        shares: null,
        clicks: null,
        saves: null,
        fetchedAt: new Date("2026-07-10T01:00:00.000Z"),
      },
    ]);

    await GET(getRequest());

    expect(postMetricFindManyMock).toHaveBeenCalledTimes(1);
    const arg = postMetricFindManyMock.mock.calls[0][0];
    // Team Workspaces (Task 4): scoped to the active WORKSPACE (never global,
    // and never just the caller — a teammate's metrics must show too).
    expect(arg.where).toEqual({
      workspaceId: "ws-1",
      platform: { in: ["youtube"] },
      externalPostId: { in: ["vidA"] },
    });
    // SEC-1: display fields only — no raw payload, id, userId, or postJobResultId.
    expect(arg.select).toEqual({
      platform: true,
      externalPostId: true,
      views: true,
      likes: true,
      comments: true,
      shares: true,
      clicks: true,
      saves: true,
      fetchedAt: true,
    });
    expect(arg.select).not.toHaveProperty("raw");
    expect(arg.select).not.toHaveProperty("userId");
  });

  it("attaches the metric to the matching YouTube result and null to others; leaks no secret fields", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([
      {
        platform: "youtube",
        externalPostId: "vidA",
        views: 100,
        likes: 5,
        comments: 2,
        shares: null,
        clicks: null,
        saves: null,
        fetchedAt: new Date("2026-07-10T01:00:00.000Z"),
      },
    ]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    const results = body.jobs[0].results;
    const youtube = results.find((r) => r.platform === "youtube");
    const tiktok = results.find((r) => r.platform === "tiktok");

    expect(youtube?.metric).toEqual({
      views: 100,
      likes: 5,
      comments: 2,
      shares: null,
      clicks: null,
      saves: null,
      fetchedAt: "2026-07-10T01:00:00.000Z",
    });
    // TikTok has no metric in v1.
    expect(tiktok?.metric).toBeNull();

    // No secret/internal fields leak through the DTO.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("raw");
    expect(serialized).not.toContain("postJobResultId");
    expect(serialized).not.toContain("accessToken");
  });

  it("joins the numbers of Instagram, Facebook, LinkedIn and Pinterest results by platform and post id", async () => {
    const job = jobWithYouTube();
    job.results = [
      { platform: "instagram", status: "success", externalPostId: "same-id", errorMessage: null },
      { platform: "pinterest", status: "success", externalPostId: "same-id", errorMessage: null },
      { platform: "linkedin", status: "success", externalPostId: "urn:li:share:1", errorMessage: null },
      { platform: "facebook_page", status: "success", externalPostId: "9_1", errorMessage: null },
      { platform: "tiktok", status: "success", externalPostId: "tikA", errorMessage: null },
    ];
    postJobFindManyMock.mockResolvedValue([job]);
    const fetchedAt = new Date("2026-11-10T10:46:00.000Z");
    const metric = (platform: string, externalPostId: string, over: Record<string, number | null>) => ({
      platform,
      externalPostId,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      clicks: null,
      saves: null,
      fetchedAt,
      ...over,
    });
    postMetricFindManyMock.mockResolvedValue([
      metric("instagram", "same-id", { likes: 12, comments: 3 }),
      metric("pinterest", "same-id", { views: 240, clicks: 37, saves: 20 }),
      metric("linkedin", "urn:li:share:1", { views: 500, clicks: 20 }),
    ]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    const arg = postMetricFindManyMock.mock.calls[0][0];
    expect(arg.where.platform.in.sort()).toEqual(["facebook_page", "instagram", "linkedin", "pinterest"]);
    expect(arg.where.externalPostId.in.sort()).toEqual(["9_1", "same-id", "urn:li:share:1"]);

    const byPlatform = Object.fromEntries(body.jobs[0].results.map((r) => [r.platform, r.metric]));
    expect(byPlatform.instagram).toMatchObject({ likes: 12, comments: 3, saves: null });
    expect(byPlatform.pinterest).toMatchObject({ views: 240, clicks: 37, saves: 20, likes: null });
    expect(byPlatform.linkedin).toMatchObject({ views: 500, clicks: 20 });
    expect(byPlatform.facebook_page).toBeNull();
    expect(byPlatform.tiktok).toBeNull();
    expect(JSON.stringify(body)).not.toContain("raw");
  });

  it("renders metric:null (not a crash) for a YouTube result with no fetched metric yet", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([]); // nothing fetched yet

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;
    const youtube = body.jobs[0].results.find((r) => r.platform === "youtube");
    expect(youtube?.metric).toBeNull();
  });

  it("does NOT query metrics when there are no YouTube video ids to join", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        id: "job-2",
        status: "completed",
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
        scheduledFor: null,
        baseCaption: "x",
        mediaItem: {
          baseCaption: "y",
          storageLocation: "https://blob.example.com/media-2.jpg",
          mimeType: "image/jpeg",
        },
        publishMetadata: null,
        results: [
          { platform: "tiktok", status: "success", externalPostId: "t1", errorMessage: null },
        ],
      },
    ]);

    await GET(getRequest());
    expect(postMetricFindManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts — media + publish snapshot (Task 8)", () => {
  it("maps mediaItem + publishMetadata onto the DTO's media/publish fields, round-tripping targetPlatforms and per-platform privacy", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;
    const job = body.jobs[0];

    expect(job.media).toEqual({
      url: "https://blob.example.com/media-1.mp4",
      mimeType: "video/mp4",
    });
    expect(job.publish).toEqual({
      targetPlatforms: ["youtube", "tiktok"],
      youtubePrivacy: "unlisted",
      tiktokPrivacy: "SELF_ONLY",
      googlePostType: null,
      googleButton: null,
    });
  });

  // 2026-11-10: the Queue card shows "Google: Offer" or "Google: Book button".
  it("maps the Google post type and button onto the DTO", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        ...jobWithYouTube(),
        publishMetadata: {
          googleBusinessProfile: { postType: "update", button: { type: "BOOK", url: "https://e.com/b" } },
        },
      },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const body = (await (await GET(getRequest())).json()) as PostsResponse;

    expect(body.jobs[0].publish).toMatchObject({ googlePostType: "update", googleButton: "BOOK" });
  });

  // Fix round 1 (Stories): which platforms the job sent as a Story.
  it("lists the job's Story platforms from its publishMetadata", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        ...jobWithYouTube(),
        publishMetadata: { instagram: { placement: "story" }, facebook: { placement: "story" } },
      },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const body = (await (await GET(getRequest())).json()) as PostsResponse;

    expect(body.jobs[0].storyPlatforms).toEqual(["instagram", "facebook_page"]);
  });

  it("a job without publishMetadata has no Story platforms", async () => {
    postJobFindManyMock.mockResolvedValue([{ ...jobWithYouTube(), publishMetadata: null }]);
    postMetricFindManyMock.mockResolvedValue([]);

    const body = (await (await GET(getRequest())).json()) as PostsResponse;

    expect(body.jobs[0].storyPlatforms).toEqual([]);
  });

  it("maps a null publishMetadata (legacy/immediate job) to publish: null", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        id: "job-3",
        status: "completed",
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
        scheduledFor: null,
        baseCaption: "legacy post",
        mediaItem: {
          baseCaption: "legacy media",
          storageLocation: "https://blob.example.com/media-3.png",
          mimeType: "image/png",
        },
        publishMetadata: null,
        results: [],
      },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;
    const job = body.jobs[0];

    expect(job.publish).toBeNull();
    expect(job.media).toEqual({
      url: "https://blob.example.com/media-3.png",
      mimeType: "image/png",
    });
  });

  it("maps a job with no mediaItem to media: null", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        id: "job-4",
        status: "completed",
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
        scheduledFor: null,
        baseCaption: "no media",
        mediaItem: null,
        publishMetadata: null,
        results: [],
      },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;
    expect(body.jobs[0].media).toBeNull();
  });

  it("leaks no new secret-bearing fields via media/publish (SEC-1)", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("socialConnectionId");
  });
});

describe("GET /api/posts — workspace scoping (Team Workspaces, Task 4)", () => {
  it("queries jobs scoped to the active workspace, selecting the creator relation for attribution", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-active" }));

    await GET(getRequest());

    expect(postJobFindManyMock).toHaveBeenCalledTimes(1);
    const arg = postJobFindManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "ws-active" });
    expect(arg.select.user).toEqual({ select: { name: true, email: true } });
  });

  it("cross-workspace isolation: a job belonging to another workspace is never requested — the query only ever asks for the caller's ACTIVE workspace id", async () => {
    // Simulates a job that lives in workspace B: since the mocked DB layer
    // only ever returns what postJobFindManyMock is told to, "isolation" here
    // means the ROUTE must ask for workspace A's id — never B's, and never
    // unscoped — so a real Prisma query could not possibly return B's rows.
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-A" }));
    postJobFindManyMock.mockResolvedValue([]); // workspace A has no jobs of its own

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(postJobFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-A" } }),
    );
    expect(body.jobs).toEqual([]);
  });

  it("includes workspaceMemberCount at the top level, counted for the ACTIVE workspace via getWorkspaceMemberCount", async () => {
    // 2026-11-01 scale audit (W3): the count is no longer on the context;
    // this route is its only consumer and asks for it explicitly.
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-A" }));
    getWorkspaceMemberCountMock.mockResolvedValue(4);
    postJobFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.workspaceMemberCount).toBe(4);
    expect(getWorkspaceMemberCountMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceMemberCountMock).toHaveBeenCalledWith("ws-A");
  });

  it("does not count members when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    await GET(getRequest());

    expect(getWorkspaceMemberCountMock).not.toHaveBeenCalled();
  });

  it("includes workspaceRole and workspaceRequireApproval — the Queue's viewer rules (2026-11-01 audit)", async () => {
    postJobFindManyMock.mockResolvedValue([]);

    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "member", requireApproval: true }),
    );
    let body = (await (await GET(getRequest())).json()) as PostsResponse;
    expect(body.workspaceRole).toBe("member");
    expect(body.workspaceRequireApproval).toBe(true);

    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "owner" }));
    body = (await (await GET(getRequest())).json()) as PostsResponse;
    expect(body.workspaceRole).toBe("owner");
    expect(body.workspaceRequireApproval).toBe(false);
  });
});

describe("GET /api/posts — updatedAt (2026-11-01 audit)", () => {
  it("selects updatedAt and exposes it as an ISO string — the version an owner reviews (sent back as reviewedUpdatedAt)", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(postJobFindManyMock.mock.calls[0][0].select.updatedAt).toBe(true);
    expect(body.jobs[0].updatedAt).toBe("2026-07-10T00:05:00.123Z");
  });
});

describe("GET /api/posts — platformCaptions (2026-11-01 audit, M1)", () => {
  /** A held draft: no results yet, the targets live in the publish snapshot. */
  function draftWithOverrides(overrides: Record<string, unknown> = {}) {
    return {
      ...jobWithYouTube(),
      status: "draft",
      results: [],
      perPlatformOverrides: { linkedin: "Hidden text" },
      publishMetadata: null,
      ...overrides,
    };
  }

  async function firstJob() {
    const res = await GET(getRequest());
    return ((await res.json()) as PostsResponse).jobs[0];
  }

  it("selects the job's AND the media item's perPlatformOverrides - everything resolvePostCaptionSource reads", async () => {
    await GET(getRequest());

    const { select } = postJobFindManyMock.mock.calls[0][0];
    expect(select.baseCaption).toBe(true);
    expect(select.perPlatformOverrides).toBe(true);
    expect(select.mediaItem.select.baseCaption).toBe(true);
    expect(select.mediaItem.select.perPlatformOverrides).toBe(true);
  });

  it("exposes the override texts the publish path will use", async () => {
    postJobFindManyMock.mockResolvedValue([draftWithOverrides()]);

    const job = await firstJob();

    expect(job.platformCaptions).toEqual({ linkedin: "Hidden text" });
    // The base caption is unchanged - the overrides are additional.
    expect(job.caption).toBe("hello");
  });

  it("is null for a job with no overrides", async () => {
    postJobFindManyMock.mockResolvedValue([draftWithOverrides({ perPlatformOverrides: null })]);

    expect((await firstJob()).platformCaptions).toBeNull();
  });

  it("only lists the platforms the job targets", async () => {
    postJobFindManyMock.mockResolvedValue([
      draftWithOverrides({
        perPlatformOverrides: { linkedin: "Hidden text", x: "X text" },
        publishMetadata: { targetPlatforms: ["x"] },
      }),
    ]);

    expect((await firstJob()).platformCaptions).toEqual({ x: "X text" });
  });

  it("does not resurrect the shared media item's overrides for a job with its own caption snapshot", async () => {
    postJobFindManyMock.mockResolvedValue([
      draftWithOverrides({
        perPlatformOverrides: null,
        mediaItem: {
          baseCaption: "media cap",
          perPlatformOverrides: { linkedin: "Old media text" },
          storageLocation: "https://blob.example.com/media-1.mp4",
          mimeType: "video/mp4",
        },
      }),
    ]);

    expect((await firstJob()).platformCaptions).toBeNull();
  });

  it("is null for a job whose media row is gone", async () => {
    postJobFindManyMock.mockResolvedValue([
      draftWithOverrides({ perPlatformOverrides: null, mediaItem: null }),
    ]);

    expect((await firstJob()).platformCaptions).toBeNull();
  });
});

describe("GET /api/posts — createdBy attribution round-trip (Team Workspaces, Task 4)", () => {
  it("maps the joined user's name onto createdBy", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]); // user: { name: "Alice", ... }
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.jobs[0].createdBy).toEqual({ name: "Alice" });
  });

  it("falls back to the email local-part when the creator has no display name, and NEVER includes the full email", async () => {
    postJobFindManyMock.mockResolvedValue([
      { ...jobWithYouTube(), user: { name: null, email: "bob.smith@example.com" } },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.jobs[0].createdBy).toEqual({ name: "bob.smith" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("bob.smith@example.com");
  });

  it("maps createdBy: null when the creator relation is missing", async () => {
    postJobFindManyMock.mockResolvedValue([
      { ...jobWithYouTube(), user: null },
    ]);
    postMetricFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.jobs[0].createdBy).toBeNull();
  });
});

describe("GET /api/posts — keyset cursor pagination (activity pagination)", () => {
  // Minimal job rows carrying only the fields the DTO mapping reads, with
  // strictly-decreasing createdAt + distinct ids (the desc total order).
  function makeJobs(count: number) {
    const base = Date.UTC(2026, 6, 10, 0, 0, 0);
    return Array.from({ length: count }, (_, i) => ({
      id: `job-${String(i).padStart(3, "0")}`,
      status: "completed",
      createdAt: new Date(base - i * 1000),
      updatedAt: new Date(base - i * 1000),
      scheduledFor: null,
      baseCaption: `cap ${i}`,
      mediaItem: null,
      publishMetadata: null,
      user: null,
      results: [],
    }));
  }

  it("first page (no cursor): no keyset filter, over-fetches PAGE_SIZE + 1, orders by the (createdAt, id) total key", async () => {
    postJobFindManyMock.mockResolvedValue(makeJobs(10));

    await GET(getRequest());

    expect(postJobFindManyMock).toHaveBeenCalledTimes(1);
    const arg = postJobFindManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "ws-1" });
    expect(arg.where).not.toHaveProperty("OR");
    // POSTS_PAGE_SIZE (50) + 1 — the extra "is there more?" probe row.
    expect(arg.take).toBe(51);
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("returns nextCursor: null when exactly PAGE_SIZE rows come back (no further page)", async () => {
    postJobFindManyMock.mockResolvedValue(makeJobs(50));

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.jobs).toHaveLength(50);
    expect(body.nextCursor).toBeNull();
  });

  it("slices the probe row and returns nextCursor from the LAST returned row when PAGE_SIZE + 1 rows come back", async () => {
    const rows = makeJobs(51);
    postJobFindManyMock.mockResolvedValue(rows);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    // 51 fetched -> 50 returned; the 51st is only a "has more" probe.
    expect(body.jobs).toHaveLength(50);
    const lastReturned = rows[49]; // row 50, 0-indexed
    expect(body.nextCursor).toBe(encodePostsCursor(lastReturned.createdAt, lastReturned.id));
    // The probe row must NOT appear in the payload.
    expect(body.jobs.some((j) => j.id === rows[50].id)).toBe(false);
  });

  it("with ?cursor=: adds the keyset OR predicate for the decoded (createdAt, id), ANDed with the workspace scope", async () => {
    const createdAt = new Date("2026-07-09T00:00:00.000Z");
    const id = "job-042";
    const cursor = encodePostsCursor(createdAt, id);
    postJobFindManyMock.mockResolvedValue(makeJobs(3));

    await GET(getRequest(`http://localhost/api/posts?cursor=${cursor}`));

    const arg = postJobFindManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      workspaceId: "ws-1",
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt: createdAt, id: { lt: id } },
      ],
    });
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("returns 400 { error: 'Invalid cursor.' } and never queries the DB for a garbage cursor", async () => {
    // A syntactically valid base64url token that decodes to a string with no
    // createdAt|id structure — i.e. a tampered/garbage cursor.
    const garbage = Buffer.from("totally-not-a-cursor").toString("base64url");

    const res = await GET(getRequest(`http://localhost/api/posts?cursor=${garbage}`));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid cursor." });
    expect(postJobFindManyMock).not.toHaveBeenCalled();
    expect(postMetricFindManyMock).not.toHaveBeenCalled();
  });

  it("composes ?status= with ?cursor= — the status filter and the keyset predicate both land in where", async () => {
    const createdAt = new Date("2026-07-09T00:00:00.000Z");
    const id = "job-042";
    const cursor = encodePostsCursor(createdAt, id);
    postJobFindManyMock.mockResolvedValue(makeJobs(2));

    await GET(getRequest(`http://localhost/api/posts?status=scheduled,draft&cursor=${cursor}`));

    const arg = postJobFindManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      workspaceId: "ws-1",
      status: { in: ["scheduled", "draft"] },
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt: createdAt, id: { lt: id } },
      ],
    });
  });
});

// 2026-11-01 scale audit (platform limits): a result waiting out a platform
// limit stays `pending`; the DTO tells the Activity card why and until when,
// without exposing the internal `errorCode`.
describe("GET /api/posts — result deferral", () => {
  const DEFERRED_UNTIL = new Date("2026-11-02T08:05:00.000Z");

  function jobWith(results: Array<Record<string, unknown>>) {
    return { ...jobWithYouTube(), status: "in_progress", results };
  }

  async function resultsOf(results: Array<Record<string, unknown>>) {
    postJobFindManyMock.mockResolvedValue([jobWith(results)]);
    const res = await GET(getRequest());
    return ((await res.json()) as PostsResponse).jobs[0].results;
  }

  it("selects deferredUntil and errorCode on the results", async () => {
    postJobFindManyMock.mockResolvedValue([]);

    await GET(getRequest());

    expect(postJobFindManyMock.mock.calls[0][0].select.results.select).toEqual({
      platform: true,
      status: true,
      externalPostId: true,
      // 2026-11-08: the post's stored public link (Instagram permalinks)
      externalPostUrl: true,
      errorMessage: true,
      deferredUntil: true,
      errorCode: true,
    });
  });

  it("maps a pending result with deferredUntil and DAILY_LIMIT to a daily_limit deferral", async () => {
    const [youtube] = await resultsOf([
      {
        platform: "youtube",
        status: "pending",
        externalPostId: null,
        errorMessage: null,
        errorCode: "DAILY_LIMIT",
        deferredUntil: DEFERRED_UNTIL,
      },
    ]);

    expect(youtube.deferral).toEqual({ kind: "daily_limit", until: "2026-11-02T08:05:00.000Z" });
  });

  it("maps RATE_LIMITED (and any other code) to a rate_limited deferral", async () => {
    const results = await resultsOf([
      {
        platform: "x",
        status: "pending",
        externalPostId: null,
        errorMessage: null,
        errorCode: "RATE_LIMITED",
        deferredUntil: DEFERRED_UNTIL,
      },
      {
        platform: "tiktok",
        status: "pending",
        externalPostId: null,
        errorMessage: null,
        errorCode: null,
        deferredUntil: DEFERRED_UNTIL,
      },
    ]);

    expect(results.map((r) => r.deferral)).toEqual([
      { kind: "rate_limited", until: "2026-11-02T08:05:00.000Z" },
      { kind: "rate_limited", until: "2026-11-02T08:05:00.000Z" },
    ]);
  });

  it("has no deferral for a failed result, even one that still carries a stale deferredUntil", async () => {
    const results = await resultsOf([
      {
        platform: "youtube",
        status: "failed",
        externalPostId: null,
        errorMessage: "YouTube's daily limit is still reached. Retry this platform later.",
        errorCode: "DAILY_LIMIT",
        deferredUntil: DEFERRED_UNTIL,
      },
      { platform: "x", status: "success", externalPostId: "t1", errorMessage: null, errorCode: null, deferredUntil: null },
    ]);

    expect(results.map((r) => r.deferral)).toEqual([null, null]);
  });

  it("has no deferral for a plain pending result (no deferredUntil)", async () => {
    const [x] = await resultsOf([
      { platform: "x", status: "pending", externalPostId: null, errorMessage: null, errorCode: null, deferredUntil: null },
    ]);

    expect(x.deferral).toBeNull();
  });

  it("never exposes errorCode or deferredUntil on a result", async () => {
    const results = await resultsOf([
      {
        platform: "youtube",
        status: "pending",
        externalPostId: null,
        errorMessage: null,
        errorCode: "DAILY_LIMIT",
        deferredUntil: DEFERRED_UNTIL,
      },
    ]);

    for (const result of results) {
      expect(result).not.toHaveProperty("errorCode");
      expect(result).not.toHaveProperty("deferredUntil");
    }
    expect(JSON.stringify(results)).not.toContain("DAILY_LIMIT");
  });
});

// 2026-11-01 scale audit (jobs H6, Task 6): a result whose commit call could not
// be confirmed (PUBLISH_UNCONFIRMED) tells the Activity card to warn inline
// before the user retries, without exposing the internal `errorCode`.
describe("GET /api/posts — unconfirmed publish", () => {
  const UNCONFIRMED_MESSAGE =
    "We couldn't confirm this post. It may already be live — check the platform before you retry.";

  function jobWith(results: Array<Record<string, unknown>>) {
    return { ...jobWithYouTube(), status: "failed", results };
  }

  async function resultsOf(results: Array<Record<string, unknown>>) {
    postJobFindManyMock.mockResolvedValue([jobWith(results)]);
    const res = await GET(getRequest());
    return ((await res.json()) as PostsResponse).jobs[0].results;
  }

  const result = (partial: Record<string, unknown>) => ({
    platform: "x",
    status: "failed",
    externalPostId: null,
    errorMessage: "Something failed",
    errorCode: "X_TWEET_FAILED",
    deferredUntil: null,
    ...partial,
  });

  it("a failed PUBLISH_UNCONFIRMED result -> unconfirmed: true", async () => {
    const [x] = await resultsOf([
      result({ errorCode: "PUBLISH_UNCONFIRMED", errorMessage: UNCONFIRMED_MESSAGE }),
    ]);

    expect(x.unconfirmed).toBe(true);
    expect(x.status).toBe("failed");
    expect(x.errorMessage).toBe(UNCONFIRMED_MESSAGE);
  });

  // Final review F4 (I2): TikTok's own "not confirmed or denied" outcome is the
  // same situation (the video may still be processing), so it warns inline too.
  it("a failed TIKTOK_PUBLISH_PENDING result -> unconfirmed: true", async () => {
    const [tiktok] = await resultsOf([
      result({ platform: "tiktok", errorCode: "TIKTOK_PUBLISH_PENDING", errorMessage: "TikTok may still be processing" }),
    ]);

    expect(tiktok.unconfirmed).toBe(true);
    expect(tiktok.status).toBe("failed");
    expect(tiktok).not.toHaveProperty("errorCode");
  });

  it("only a failed TIKTOK_PUBLISH_PENDING result is unconfirmed: a pending or successful one is not", async () => {
    const results = await resultsOf([
      result({ platform: "tiktok", status: "pending", errorCode: "TIKTOK_PUBLISH_PENDING" }),
      result({ platform: "youtube", status: "success", externalPostId: "vid", errorCode: "TIKTOK_PUBLISH_PENDING" }),
    ]);

    expect(results.map((r) => r.unconfirmed)).toEqual([false, false]);
  });

  it("any other failure -> unconfirmed: false", async () => {
    const results = await resultsOf([
      result({ platform: "x", errorCode: "X_TWEET_FAILED" }),
      result({ platform: "youtube", errorCode: "RATE_LIMITED" }),
      result({ platform: "tiktok", errorCode: "PUBLISH_INTERRUPTED" }),
      result({ platform: "linkedin", errorCode: null }),
    ]);

    expect(results.map((r) => r.unconfirmed)).toEqual([false, false, false, false]);
  });

  it("only a failed result is unconfirmed: a pending or successful one carrying the code is not", async () => {
    const results = await resultsOf([
      result({ platform: "x", status: "pending", errorCode: "PUBLISH_UNCONFIRMED" }),
      result({ platform: "youtube", status: "success", externalPostId: "vid", errorCode: "PUBLISH_UNCONFIRMED" }),
    ]);

    expect(results.map((r) => r.unconfirmed)).toEqual([false, false]);
  });

  it("is a boolean on every result and never exposes errorCode", async () => {
    const results = await resultsOf([
      result({ platform: "x", errorCode: "PUBLISH_UNCONFIRMED" }),
      result({ platform: "youtube", status: "success", errorCode: null, errorMessage: null }),
    ]);

    for (const r of results) {
      expect(typeof r.unconfirmed).toBe("boolean");
      expect(r).not.toHaveProperty("errorCode");
    }
    expect(JSON.stringify(results)).not.toContain("PUBLISH_UNCONFIRMED");
  });
});

describe("GET /api/posts - mediaCount (07a)", () => {
  it("does not count photo rows inside the page query", async () => {
    await GET(getRequest());

    expect(postJobFindManyMock.mock.calls[0][0].select).not.toHaveProperty("_count");
  });

  it("counts the page's photo rows in one grouped query by post id", async () => {
    postJobFindManyMock.mockResolvedValue([
      { ...jobWithYouTube(), id: "job-single" },
      { ...jobWithYouTube(), id: "job-multi" },
    ]);
    postJobMediaGroupByMock.mockResolvedValue([{ postJobId: "job-multi", _count: { _all: 3 } }]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(postJobMediaGroupByMock).toHaveBeenCalledTimes(1);
    expect(postJobMediaGroupByMock).toHaveBeenCalledWith({
      by: ["postJobId"],
      where: { postJobId: { in: ["job-single", "job-multi"] } },
      _count: { _all: true },
    });
    expect(body.jobs.map((job) => [job.id, job.mediaCount])).toEqual([
      ["job-single", 1],
      ["job-multi", 3],
    ]);
  });

  it("makes no count query for an empty page", async () => {
    await GET(getRequest());

    expect(postJobMediaGroupByMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts - the client's review (client review link)", () => {
  it("selects the three client columns and exposes them as ISO strings and text", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        ...jobWithYouTube(),
        id: "changed",
        status: "draft",
        clientApprovedAt: null,
        clientChangeRequestedAt: new Date("2026-11-10T09:00:00.000Z"),
        clientNote: "Use the <b>other</b> photo",
      },
      {
        ...jobWithYouTube(),
        id: "approved",
        status: "scheduled",
        clientApprovedAt: new Date("2026-11-10T08:00:00.000Z"),
        clientChangeRequestedAt: null,
        clientNote: null,
      },
      // A row from before the columns existed reads as no review.
      { ...jobWithYouTube(), id: "plain" },
    ]);

    const body = (await (await GET(getRequest())).json()) as PostsResponse;

    const { select } = postJobFindManyMock.mock.calls[0][0];
    expect(select.clientApprovedAt).toBe(true);
    expect(select.clientChangeRequestedAt).toBe(true);
    expect(select.clientNote).toBe(true);
    expect(body.jobs.map((job) => [job.id, job.clientApprovedAt, job.clientChangeRequestedAt, job.clientNote])).toEqual([
      ["changed", null, "2026-11-10T09:00:00.000Z", "Use the <b>other</b> photo"],
      ["approved", "2026-11-10T08:00:00.000Z", null, null],
      ["plain", null, null, null],
    ]);
  });

  it("says which workspace the list is for, so the Queue's link panel acts on that one", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-7" }));
    const body = (await (await GET(getRequest())).json()) as PostsResponse;
    expect(body.workspaceId).toBe("ws-7");
  });

  it("is never read by a signed-out caller", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await GET(getRequest())).status).toBe(401);
    expect(postJobFindManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts - client change requests on the Queue's first page (client review link)", () => {
  const QUEUE_URL = "http://localhost/api/posts?status=scheduled,draft&clientChangesFirst=1";
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ ...jobWithYouTube(), id, ...extra });

  it("adds up to 20 drafts with a client change request, oldest request first, to the first page", async () => {
    postJobFindManyMock
      .mockResolvedValueOnce([row("new-1"), row("changed-b", { status: "draft" })])
      .mockResolvedValueOnce([
        row("changed-a", { status: "draft" }),
        row("changed-b", { status: "draft" }),
      ]);

    const body = (await (await GET(getRequest(QUEUE_URL))).json()) as PostsResponse;

    expect(postJobFindManyMock).toHaveBeenCalledTimes(2);
    const pinned = postJobFindManyMock.mock.calls[1][0];
    expect(pinned.where).toEqual({
      workspaceId: "ws-1",
      status: "draft",
      clientChangeRequestedAt: { not: null },
    });
    expect(pinned.orderBy).toEqual([{ clientChangeRequestedAt: "asc" }, { id: "asc" }]);
    expect(pinned.take).toBe(20);
    // The same display-safe select as the page.
    expect(pinned.select).toEqual(postJobFindManyMock.mock.calls[0][0].select);
    // Each post once; the page's own order and cursor are untouched.
    expect(body.jobs.map((job) => job.id)).toEqual(["changed-a", "changed-b", "new-1"]);
    expect(body.nextCursor).toBeNull();
  });

  it("keeps the cursor from the normal page, so the next page follows it as before", async () => {
    const page = Array.from({ length: 51 }, (_, i) => row(`job-${i}`, {
      createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 51 - i)),
    }));
    postJobFindManyMock.mockResolvedValueOnce(page).mockResolvedValueOnce([row("changed-old", { status: "draft" })]);

    const body = (await (await GET(getRequest(QUEUE_URL))).json()) as PostsResponse;

    expect(body.jobs).toHaveLength(51);
    expect(body.jobs[0].id).toBe("changed-old");
    expect(body.nextCursor).toBe(encodePostsCursor(page[49].createdAt, "job-49"));
  });

  it("changes nothing for any other caller, a later page, or a list without drafts", async () => {
    for (const url of [
      "http://localhost/api/posts?status=scheduled,draft",
      "http://localhost/api/posts",
      `${QUEUE_URL}&cursor=${encodePostsCursor(new Date("2026-07-10T00:00:00Z"), "job-1")}`,
      "http://localhost/api/posts?status=scheduled&clientChangesFirst=1",
    ]) {
      postJobFindManyMock.mockClear();
      postJobFindManyMock.mockResolvedValue([]);
      await GET(getRequest(url));
      expect(postJobFindManyMock, url).toHaveBeenCalledTimes(1);
    }
  });
});
