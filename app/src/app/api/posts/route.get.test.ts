import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PostsResponse } from "@/lib/postsDto";
import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// Roadmap Phase 8 — GET /api/posts metrics join. route.ts imports several
// modules at scope but GET only uses getWorkspaceContext (Team Workspaces,
// Task 4) + prisma.postJob.findMany + prisma.postMetric.findMany; the rest
// are mocked so the module loads without real side effects (mirrors
// route.test.ts, which covers POST).
const {
  getWorkspaceContextMock,
  postJobFindManyMock,
  postMetricFindManyMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  postJobFindManyMock: vi.fn(),
  postMetricFindManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
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
  postJobFindManyMock.mockReset();
  postMetricFindManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  postJobFindManyMock.mockResolvedValue([]);
  postMetricFindManyMock.mockResolvedValue([]);
});

describe("GET /api/posts — metrics join (Roadmap Phase 8)", () => {
  it("401s when unauthenticated and never queries", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(postJobFindManyMock).not.toHaveBeenCalled();
    expect(postMetricFindManyMock).not.toHaveBeenCalled();
  });

  it("scopes the metric query to the caller + youtube + the collected video ids, selecting display fields only", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([
      {
        externalPostId: "vidA",
        views: 100,
        likes: 5,
        comments: 2,
        shares: null,
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
      platform: "youtube",
      externalPostId: { in: ["vidA"] },
    });
    // SEC-1: display fields only — no raw payload, id, userId, or postJobResultId.
    expect(arg.select).toEqual({
      externalPostId: true,
      views: true,
      likes: true,
      comments: true,
      shares: true,
      fetchedAt: true,
    });
    expect(arg.select).not.toHaveProperty("raw");
    expect(arg.select).not.toHaveProperty("userId");
  });

  it("attaches the metric to the matching YouTube result and null to others; leaks no secret fields", async () => {
    postJobFindManyMock.mockResolvedValue([jobWithYouTube()]);
    postMetricFindManyMock.mockResolvedValue([
      {
        externalPostId: "vidA",
        views: 100,
        likes: 5,
        comments: 2,
        shares: null,
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
    });
  });

  it("maps a null publishMetadata (legacy/immediate job) to publish: null", async () => {
    postJobFindManyMock.mockResolvedValue([
      {
        id: "job-3",
        status: "completed",
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
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

  it("includes workspaceMemberCount at the top level, from the context's memberCount", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ memberCount: 4 }));
    postJobFindManyMock.mockResolvedValue([]);

    const res = await GET(getRequest());
    const body = (await res.json()) as PostsResponse;

    expect(body.workspaceMemberCount).toBe(4);
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
