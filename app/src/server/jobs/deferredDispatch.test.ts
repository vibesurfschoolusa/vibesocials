import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused suite for prepareDeferredPostJobDispatch (the §6.3 run-time
// result-creation fix). Isolated in its own file so its `@/lib/db` mock only
// needs the handful of methods this helper touches. vitest hoists vi.mock.
const {
  postJobFindUniqueMock,
  postJobUpdateMock,
  connectionFindManyMock,
  resultCountMock,
  resultCreateManyMock,
} = vi.hoisted(() => ({
  postJobFindUniqueMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  connectionFindManyMock: vi.fn(),
  resultCountMock: vi.fn(),
  resultCreateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock, update: postJobUpdateMock },
    socialConnection: { findMany: connectionFindManyMock },
    postJobResult: { count: resultCountMock, createMany: resultCreateManyMock },
  },
}));

import { prepareDeferredPostJobDispatch } from "./posting";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    mediaItemId: "media-1",
    baseCaption: "Job snapshot caption",
    perPlatformOverrides: null,
    mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null },
    ...overrides,
  };
}

beforeEach(() => {
  postJobFindUniqueMock.mockReset();
  postJobUpdateMock.mockReset();
  connectionFindManyMock.mockReset();
  resultCountMock.mockReset();
  resultCreateManyMock.mockReset();

  postJobUpdateMock.mockResolvedValue({});
  resultCountMock.mockResolvedValue(0);
  resultCreateManyMock.mockResolvedValue({ count: 0 });
});

describe("prepareDeferredPostJobDispatch", () => {
  it("returns NOT_FOUND when the job doesn't exist", async () => {
    postJobFindUniqueMock.mockResolvedValue(null);

    const result = await prepareDeferredPostJobDispatch("missing");

    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  it("marks the job failed and returns NO_CONNECTIONS when no connections exist at run time", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  // Team Workspaces (Task 5) — the run-time fan-out must key the connection
  // lookup off the JOB's workspace, not its creator's personal workspace, so
  // a member posting into a shared workspace still fans out to every
  // teammate-connected platform, not just the ones they'd see solo.
  it("fans out the connection lookup by the job's workspaceId, not its userId", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ workspaceId: "workspace-42", userId: "user-1" }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    await prepareDeferredPostJobDispatch("job-1");

    expect(connectionFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-42", needsReconnect: false },
    });
  });

  it("creates a result PER CURRENT connection and returns the publish payload", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    // These are the connections that exist NOW — the run-time fan-out.
    connectionFindManyMock.mockResolvedValue([
      { id: "c-tiktok", platform: "tiktok" },
      { id: "c-youtube", platform: "youtube" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "tiktok", socialConnectionId: "c-tiktok", status: "pending" },
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "youtube", socialConnectionId: "c-youtube", status: "pending" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      event: {
        postJobId: "job-1",
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: "media-1",
        baseCaption: "Job snapshot caption",
        perPlatformOverrides: null,
      },
    });
  });

  // 2026-11-01 scale audit (jobs H1): the shared per-workspace concurrency key
  // (publishFlowControl.ts) is evaluated against event.data.workspaceId, so the
  // deferred dispatch must carry the job's workspace in its event.
  it("puts the job's workspaceId in the publish event", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ workspaceId: "ws-1" }));
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.workspaceId).toBe("ws-1");
  });

  it("is idempotent — does NOT recreate results if some already exist", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    resultCountMock.mockResolvedValue(1); // a prior attempt already created them

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("replays the persisted publishMetadata (per-post privacy) into the event — review B1", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        publishMetadata: {
          youtube: { privacyStatus: "private" },
          tiktok: { privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false },
        },
      }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-youtube", platform: "youtube" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The user chose "private"; the deferred publish must NOT escalate it to
      // the client-default "unlisted".
      expect(result.event.youtubeMetadata).toEqual({ privacyStatus: "private" });
      expect(result.event.tiktokMetadata).toEqual({
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
      });
    }
  });

  it("replays the Google options so a scheduled or approved post publishes with them (2026-11-10)", async () => {
    const google = { postType: "update", button: { type: "BOOK", url: "https://e.com/book" } };
    postJobFindUniqueMock.mockResolvedValue(makeJob({ publishMetadata: { googleBusinessProfile: google } }));
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.googleMetadata).toEqual(google);
  });

  it("replays a Story placement so a scheduled Story stays a Story (2026-11-10)", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { instagram: { placement: "story" }, facebook: { placement: "story" } } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.instagramMetadata).toEqual({ placement: "story" });
      expect(result.event.facebookMetadata).toEqual({ placement: "story" });
    }
  });

  it("omits tiktok/youtube metadata from the event when the job has no publishMetadata", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ publishMetadata: null }));
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).not.toHaveProperty("tiktokMetadata");
      expect(result.event).not.toHaveProperty("youtubeMetadata");
      expect(result.event).not.toHaveProperty("googleMetadata");
      expect(result.event).not.toHaveProperty("instagramMetadata");
      expect(result.event).not.toHaveProperty("facebookMetadata");
    }
  });

  // Fix round 1 (review IMPORTANT #1): PATCH clearing a draft's overrides
  // writes DbNull; the dispatch must then publish with NO overrides, not the
  // per-platform text the shared media item kept from its first upload.
  it("does not resurrect the media item's overrides for a job whose snapshot has none", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        baseCaption: "Job snapshot caption",
        perPlatformOverrides: null,
        mediaItem: { baseCaption: "Media caption", perPlatformOverrides: { x: "deleted X text" } },
      }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.baseCaption).toBe("Job snapshot caption");
      expect(result.event.perPlatformOverrides).toBeNull();
    }
  });

  it("falls back to the media item's caption/overrides when the job has no snapshot", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        baseCaption: null,
        perPlatformOverrides: null,
        mediaItem: { baseCaption: "Media caption", perPlatformOverrides: { x: "override" } },
      }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.baseCaption).toBe("Media caption");
      expect(result.event.perPlatformOverrides).toEqual({ x: "override" });
    }
  });

  // Task 7 — per-post platform targeting replayed from the publishMetadata
  // snapshot at run time, same as tiktok/youtube privacy (review B1).
  it("narrows result creation to only the connections in publishMetadata.targetPlatforms", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["youtube"] } }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-youtube", platform: "youtube" },
      { id: "c-x", platform: "x" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [{ postJobId: "job-1", workspaceId: "workspace-1", platform: "youtube", socialConnectionId: "c-youtube", status: "pending" }],
    });
    expect(result.ok).toBe(true);
  });

  it("marks the job failed when targetPlatforms excludes every connection that exists at run time", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["tiktok"] } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-youtube", platform: "youtube" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  // 2026-11-01 audit (Task 9) - with no explicit platform list, the run-time
  // fan-out skips connections whose client can't publish the media (no result
  // row, no doomed failure). An explicit snapshot list is left as chosen.
  it("skips connections that can't publish the media when the snapshot has no target list", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null, mimeType: "image/png" } }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-youtube", platform: "youtube" },
      { id: "c-x", platform: "x" },
      { id: "c-tiktok", platform: "tiktok" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [{ postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "pending" }],
    });
    expect(result.ok).toBe(true);
  });

  it("marks the job failed when no connection can publish the media and no target list was chosen", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null, mimeType: "image/png" } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-youtube", platform: "youtube" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  it("does not second-guess an explicit target list, whatever the media type", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        publishMetadata: { targetPlatforms: ["youtube"] },
        mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null, mimeType: "image/png" },
      }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-youtube", platform: "youtube" }]);

    await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [{ postJobId: "job-1", workspaceId: "workspace-1", platform: "youtube", socialConnectionId: "c-youtube", status: "pending" }],
    });
  });
});

describe("prepareDeferredPostJobDispatch - a post without a file", () => {
  it("carries a text post through: no file in the event, and only text platforms when no list was chosen", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ mediaItemId: null, mediaItem: null, baseCaption: "Wind is onshore" }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-ig", platform: "instagram" },
      { id: "c-x", platform: "x" },
      { id: "c-gbp", platform: "google_business_profile" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "pending" },
        {
          postJobId: "job-1",
          workspaceId: "workspace-1",
          platform: "google_business_profile",
          socialConnectionId: "c-gbp",
          status: "pending",
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      event: {
        postJobId: "job-1",
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: null,
        baseCaption: "Wind is onshore",
        perPlatformOverrides: null,
      },
    });
  });

  it("replays a text post's Google options and its chosen platforms", async () => {
    const googleBusinessProfile = { postType: "offer", offer: { title: "10% off", startDate: "2030-01-01", endDate: "2030-01-31" } };
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        mediaItemId: null,
        mediaItem: null,
        publishMetadata: { targetPlatforms: ["google_business_profile"], googleBusinessProfile },
      }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-x", platform: "x" },
      { id: "c-gbp", platform: "google_business_profile" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result).toMatchObject({ ok: true, event: { mediaItemId: null, googleMetadata: googleBusinessProfile } });
    expect(resultCreateManyMock.mock.calls[0][0].data.map((r: { platform: string }) => r.platform)).toEqual([
      "google_business_profile",
    ]);
  });
});
