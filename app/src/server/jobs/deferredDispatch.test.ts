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
  recomputeMock,
  finishMock,
  serviceCapMock,
} = vi.hoisted(() => ({
  postJobFindUniqueMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  connectionFindManyMock: vi.fn(),
  resultCountMock: vi.fn(),
  resultCreateManyMock: vi.fn(),
  recomputeMock: vi.fn(),
  finishMock: vi.fn(),
  serviceCapMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock, update: postJobUpdateMock },
    socialConnection: { findMany: connectionFindManyMock },
    postJobResult: { count: resultCountMock, createMany: resultCreateManyMock },
  },
}));

// The row-locked status recompute has its own suite (failPendingResults.test.ts).
vi.mock("./failPendingResults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./failPendingResults")>()),
  recomputeAndStorePostJobStatus: recomputeMock,
  finishPostJob: finishMock,
}));

// R6-security M2: the service's cap at send has its own suite (usageLog.test.ts).
vi.mock("@/server/usage/usageLog", () => ({ serviceCapRefusalAtSend: serviceCapMock }));

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
  recomputeMock.mockReset();
  finishMock.mockReset();
  finishMock.mockResolvedValue(1);

  postJobUpdateMock.mockResolvedValue({});
  recomputeMock.mockResolvedValue({ status: "failed", successCount: 0 });
  resultCountMock.mockResolvedValue(0);
  resultCreateManyMock.mockResolvedValue({ count: 0 });
  serviceCapMock.mockReset();
  serviceCapMock.mockResolvedValue(null);
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
    // Review round 2, items 1 and 6: through the finalize helper, which stamps the media.
    expect(finishMock).toHaveBeenCalledWith(expect.anything(), {
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(postJobUpdateMock).not.toHaveBeenCalled();
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

    // F1 H1: every connection, dead ones too, so a chosen platform that needs
    // reconnecting gets a failed result instead of silently none.
    expect(connectionFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-42" },
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

  // F1 H1: a chosen platform whose connection was removed gets a failed result
  // that says so (no connection to point at), never silently nothing.
  it("gives a chosen platform with no connection a CONNECTION_GONE result and fails the job", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["tiktok"] } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-youtube", platform: "youtube" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        {
          postJobId: "job-1",
          workspaceId: "workspace-1",
          platform: "tiktok",
          socialConnectionId: null,
          status: "failed",
          errorCode: "CONNECTION_GONE",
          errorMessage: "TikTok is no longer connected. Connect it in Settings, then retry.",
        },
      ],
    });
    expect(recomputeMock).toHaveBeenCalledWith("job-1");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
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

// F1 H1 (R1 publishing): the run-time fan-out used to read only healthy
// connections, so a chosen platform whose connection needed reconnecting got no
// result at all: the post read "completed" without it, or, when every platform
// was dead, "failed" with no results ("no platforms were connected") and nothing
// to retry. Every chosen platform now gets a row.
describe("prepareDeferredPostJobDispatch - dead or removed connections (F1 H1)", () => {
  const RECONNECT_IG = {
    postJobId: "job-1",
    workspaceId: "workspace-1",
    platform: "instagram",
    socialConnectionId: "c-ig",
    status: "failed",
    errorCode: "RECONNECT_REQUIRED",
    errorMessage: "Reconnect Instagram in Settings, then retry.",
  };

  it("one dead of two: a pending result for the healthy one, a RECONNECT_REQUIRED one for the dead one", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["x", "instagram"] } }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-x", platform: "x", needsReconnect: false },
      { id: "c-ig", platform: "instagram", needsReconnect: true },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "pending" },
        RECONNECT_IG,
      ],
    });
    // The healthy platform publishes; the run's finalize computes the job from both rows.
    expect(result.ok).toBe(true);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("all dead: every chosen platform gets a failed result with its sentence, and the job is computed from them", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["instagram", "linkedin"] } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: true }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        RECONNECT_IG,
        {
          postJobId: "job-1",
          workspaceId: "workspace-1",
          platform: "linkedin",
          socialConnectionId: null,
          status: "failed",
          errorCode: "CONNECTION_GONE",
          errorMessage: "LinkedIn is no longer connected. Connect it in Settings, then retry.",
        },
      ],
    });
    expect(recomputeMock).toHaveBeenCalledWith("job-1");
    // Never the bare "no results" failure.
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
  });

  it("with no chosen list, a dead connection that could take the media gets a RECONNECT_REQUIRED result", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null, mimeType: "image/png" } }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-x", platform: "x", needsReconnect: false },
      { id: "c-ig", platform: "instagram", needsReconnect: true },
      // YouTube cannot take a photo: no row, as before.
      { id: "c-yt", platform: "youtube", needsReconnect: true },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "pending" },
        RECONNECT_IG,
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("a re-run that finds the rows already made creates nothing and decides the same", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["instagram"] } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: true }]);
    resultCountMock.mockResolvedValue(1);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
  });

  it("healthy connections: the same rows as before (pending, no error fields)", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ publishMetadata: { targetPlatforms: ["x", "instagram"] } }),
    );
    connectionFindManyMock.mockResolvedValue([
      { id: "c-x", platform: "x", needsReconnect: false },
      { id: "c-ig", platform: "instagram", needsReconnect: false },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "pending" },
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "instagram", socialConnectionId: "c-ig", status: "pending" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(recomputeMock).not.toHaveBeenCalled();
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

// R6-security M2: a scheduled post meets the service's cap as it falls due,
// so posts scheduled far ahead cannot fill a day.
describe("prepareDeferredPostJobDispatch with the service's cap at send (the scanner)", () => {
  const NOW = new Date("2026-11-14T15:00:00Z");
  const FULL = {
    errorCode: "SERVICE_DAILY_POST_LIMIT",
    errorMessage:
      "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.",
  };
  const RECONNECT_IG = {
    postJobId: "job-1",
    workspaceId: "workspace-1",
    platform: "instagram",
    socialConnectionId: "c-ig",
    status: "failed",
    errorCode: "RECONNECT_REQUIRED",
    errorMessage: "Reconnect Instagram in Settings, then retry.",
  };

  it("sends below the cap, having asked about this post in its workspace", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobId: "job-1", now: NOW });
    expect(result.ok).toBe(true);
  });

  it("at the cap, every platform gets a failed result that says why, and nothing is sent", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ publishMetadata: { targetPlatforms: ["x", "instagram"] } }));
    connectionFindManyMock.mockResolvedValue([
      { id: "c-x", platform: "x", needsReconnect: false },
      { id: "c-ig", platform: "instagram", needsReconnect: true },
    ]);
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", workspaceId: "workspace-1", platform: "x", socialConnectionId: "c-x", status: "failed", ...FULL },
        RECONNECT_IG,
      ],
    });
    expect(recomputeMock).toHaveBeenCalledWith("job-1");
    expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED" });
  });

  it("a re-run whose results were made already is not checked again", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    resultCountMock.mockResolvedValue(1);
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(serviceCapMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("Post now and approvals (no option) are not checked here: their routes checked before the claim", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    serviceCapMock.mockResolvedValue(FULL);

    expect((await prepareDeferredPostJobDispatch("job-1")).ok).toBe(true);
    expect(serviceCapMock).not.toHaveBeenCalled();
  });
});
