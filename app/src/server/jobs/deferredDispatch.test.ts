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
  recordSendMock,
  postJobFindFirstMock,
  resultFindManyMock,
  withdrawSendMock,
  sendRecordedMock,
} = vi.hoisted(() => ({
  postJobFindUniqueMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  connectionFindManyMock: vi.fn(),
  resultCountMock: vi.fn(),
  resultCreateManyMock: vi.fn(),
  recomputeMock: vi.fn(),
  finishMock: vi.fn(),
  serviceCapMock: vi.fn(),
  recordSendMock: vi.fn(),
  postJobFindFirstMock: vi.fn(),
  resultFindManyMock: vi.fn(),
  withdrawSendMock: vi.fn(),
  sendRecordedMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock, findFirst: postJobFindFirstMock, update: postJobUpdateMock },
    socialConnection: { findMany: connectionFindManyMock },
    postJobResult: {
      count: resultCountMock,
      createMany: resultCreateManyMock,
      findMany: resultFindManyMock,
    },
  },
}));

// The row-locked status recompute has its own suite (failPendingResults.test.ts).
vi.mock("./failPendingResults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./failPendingResults")>()),
  recomputeAndStorePostJobStatus: recomputeMock,
  finishPostJob: finishMock,
}));

// R6-security M2: the service's cap at send has its own suite (usageLog.test.ts).
vi.mock("@/server/usage/usageLog", () => ({
  serviceCapRefusalAtSend: serviceCapMock,
  recordSend: recordSendMock,
  withdrawSend: withdrawSendMock,
  sendRecorded: sendRecordedMock,
}));

import { deferredPostCanSend, prepareDeferredPostJobDispatch } from "./posting";

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
  recordSendMock.mockReset();
  recordSendMock.mockResolvedValue(undefined);
  postJobFindFirstMock.mockReset();
  postJobFindFirstMock.mockResolvedValue(null);
  resultFindManyMock.mockReset();
  resultFindManyMock.mockResolvedValue([]);
  withdrawSendMock.mockReset();
  withdrawSendMock.mockResolvedValue(undefined);
  sendRecordedMock.mockReset();
  sendRecordedMock.mockResolvedValue(false);
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

  const PAIR_HALF_SELECT = {
    id: true,
    status: true,
    publishMetadata: true,
    mediaItem: { select: { mimeType: true } },
    _count: { select: { results: true } },
  };
  /** The other half as pairHalf reads it: due with this one, an image going to every connection. */
  const half = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: "in_progress",
    publishMetadata: null,
    mediaItem: { mimeType: "image/jpeg" },
    _count: { results: 0 },
    ...overrides,
  });

  /** The job, and the other half of its pair when there is one (looked up by id). */
  function jobs(rows: Record<string, Record<string, unknown>>) {
    postJobFindUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      rows[where.id] ? makeJob({ id: where.id, ...rows[where.id] }) : null,
    );
  }

  it("sends below the cap, alone, and records the send before the next post is checked", async () => {
    jobs({ "job-1": {} });
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    // R7 review, point 7: the run is recorded first, then counted with it.
    expect(recordSendMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1"], at: NOW });
    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1"], now: NOW, recorded: true });
    expect(recordSendMock.mock.invocationCallOrder[0]).toBeLessThan(serviceCapMock.mock.invocationCallOrder[0]);
    expect(result.ok).toBe(true);
  });

  it("past the cap, the run it recorded is taken back, and only that one", async () => {
    jobs({ "job-1": {} });
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    recordSendMock.mockResolvedValue(["job-1"]);
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["job-1"], day: NOW });
    expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
  });

  it("at the cap, every platform gets a failed result that says why, nothing is sent or recorded", async () => {
    jobs({ "job-1": { publishMetadata: { targetPlatforms: ["x", "instagram"] } } });
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
    expect(recordSendMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
  });

  // Point 3: a Feed and Story pair passes or fails the cap together.
  describe("a Feed and Story pair due together", () => {
    beforeEach(() => {
      connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: false }]);
    });

    it("checks both halves as one unit and reserves both sends when they fit", async () => {
      jobs({ "job-1": {}, "story-1": { storyOfPostJobId: "job-1" } });
      postJobFindFirstMock.mockResolvedValue(half("story-1"));

      const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

      expect(postJobFindFirstMock).toHaveBeenCalledWith({
        where: { storyOfPostJobId: "job-1" },
        select: PAIR_HALF_SELECT,
      });
      expect(serviceCapMock).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        postJobIds: ["job-1", "story-1"],
        now: NOW,
        recorded: true,
      });
      expect(recordSendMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1", "story-1"], at: NOW });
      expect(result.ok).toBe(true);
    });

    it("when they do not fit, fails both halves with the at-send sentence and asks for one notice, the feed's", async () => {
      jobs({ "job-1": {}, "story-1": { storyOfPostJobId: "job-1" } });
      postJobFindFirstMock.mockResolvedValue(half("story-1"));
      serviceCapMock.mockResolvedValue(FULL);

      const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

      const failedFor = resultCreateManyMock.mock.calls.map(([args]) => args.data[0].postJobId);
      expect(failedFor).toEqual(["job-1", "story-1"]);
      for (const [args] of resultCreateManyMock.mock.calls) {
        expect(args.data.every((row: { status: string; errorCode: string }) => row.status === "failed" && row.errorCode === FULL.errorCode)).toBe(true);
      }
      expect(recomputeMock.mock.calls.map(([id]) => id)).toEqual(["job-1", "story-1"]);
      // Checked once, for the pair; its runs were recorded for the check and taken back.
      expect(serviceCapMock).toHaveBeenCalledTimes(1);
      expect(recordSendMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
    });

    it("from the story half, the unit is the same and the notice is the feed's", async () => {
      jobs({ "job-1": {}, "story-1": { storyOfPostJobId: "job-1" } });
      postJobFindUniqueMock.mockImplementation(async ({ where, select }: { where: { id: string }; select?: unknown }) =>
        select
          ? half("job-1")
          : makeJob({ id: where.id, ...(where.id === "story-1" ? { storyOfPostJobId: "job-1" } : {}) }),
      );
      serviceCapMock.mockResolvedValue(FULL);

      const result = await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

      expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1", "job-1"], now: NOW, recorded: true });
      expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
    });

    it("the partner already sent or cancelled: the remaining half is checked alone", async () => {
      jobs({ "job-1": {} });
      postJobFindFirstMock.mockResolvedValue({ id: "story-1", status: "completed", _count: { results: 1 } });
      await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });
      expect(serviceCapMock).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1"], now: NOW, recorded: true });

      postJobFindFirstMock.mockResolvedValue({ id: "story-1", status: "cancelled", _count: { results: 0 } });
      await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });
      expect(serviceCapMock).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1"], now: NOW, recorded: true });
    });
  });

  // Point 4: a re-run after a refusal must not publish.
  describe("a re-run after a refusal", () => {
    it("results already failed with the cap: refused again, status recomputed, no publish event, no new rows", async () => {
      jobs({ "job-1": {} });
      connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
      resultCountMock.mockResolvedValue(1);
      resultFindManyMock.mockResolvedValue([{ status: "failed", errorCode: "SERVICE_DAILY_POST_LIMIT" }]);

      const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

      expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
      expect(resultCreateManyMock).not.toHaveBeenCalled();
      expect(serviceCapMock).not.toHaveBeenCalled();
      expect(recomputeMock).toHaveBeenCalledWith("job-1");
    });

    it("results written, the recompute threw, the re-run: refused, failed, no publish event", async () => {
      jobs({ "job-1": {} });
      connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
      serviceCapMock.mockResolvedValue(FULL);
      recomputeMock.mockRejectedValueOnce(new Error("lock timeout"));

      await expect(prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW })).rejects.toThrow("lock timeout");

      resultCountMock.mockResolvedValue(1);
      resultFindManyMock.mockResolvedValue([{ status: "failed", errorCode: "SERVICE_DAILY_POST_LIMIT" }]);
      const again = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

      expect(again).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1" });
      expect(resultCreateManyMock).toHaveBeenCalledTimes(1);
      expect(recomputeMock).toHaveBeenCalledTimes(2);
    });

    it("a re-run whose results are pending (made before a crash) sends, without a second check", async () => {
      jobs({ "job-1": {} });
      connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
      resultCountMock.mockResolvedValue(1);
      resultFindManyMock.mockResolvedValue([{ status: "pending", errorCode: null }]);
      serviceCapMock.mockResolvedValue(FULL);

      const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

      expect(serviceCapMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });
  });

  it("Post now and approvals (no option) are not checked here, but their send is recorded", async () => {
    jobs({ "job-1": {} });
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    serviceCapMock.mockResolvedValue(FULL);

    expect((await prepareDeferredPostJobDispatch("job-1")).ok).toBe(true);
    expect(serviceCapMock).not.toHaveBeenCalled();
    expect(recordSendMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["job-1"], at: expect.any(Date) });
  });
});

// Second and third reviews of K2.
describe("prepareDeferredPostJobDispatch - who is told, and the sends it wrote", () => {
  const NOW = new Date("2026-11-14T15:00:00Z");
  const FULL = {
    errorCode: "SERVICE_DAILY_POST_LIMIT",
    errorMessage:
      "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.",
  };
  const PARTNER_SELECT = {
    id: true,
    status: true,
    publishMetadata: true,
    mediaItem: { select: { mimeType: true } },
    _count: { select: { results: true } },
  };
  const REFUSED = [{ status: "failed", errorCode: "SERVICE_DAILY_POST_LIMIT" }];

  /** The pair feed `job-1` and Story `story-1`; `other` is what the lookup of the other half answers. */
  function pair(other: Record<string, unknown> | null) {
    postJobFindUniqueMock.mockImplementation(async ({ where, select }: { where: { id: string }; select?: unknown }) =>
      select
        ? other
          ? { id: where.id, ...other }
          : null
        : makeJob({ id: where.id, storyOfPostJobId: where.id === "story-1" ? "job-1" : null }),
    );
    postJobFindFirstMock.mockResolvedValue(other ? { id: "story-1", ...other } : null);
  }

  /** Each half's stored results, by post. */
  function stored(byPost: Record<string, Array<Record<string, unknown>>>) {
    resultCountMock.mockResolvedValue(1);
    resultFindManyMock.mockImplementation(async ({ where }: { where: { postJobId: string } }) => byPost[where.postJobId] ?? []);
  }

  beforeEach(() => {
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram" }]);
  });

  // Point 1: the feed's notice only when both halves were refused together.
  it("a Story refused alone (its feed cancelled) gets its own notice", async () => {
    pair({ status: "cancelled", _count: { results: 0 } });
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

    expect(postJobFindUniqueMock).toHaveBeenCalledWith({ where: { id: "job-1" }, select: PARTNER_SELECT });
    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1"], now: NOW, recorded: true });
    expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "story-1" });
  });

  it("a Story refused alone (its feed already sent) gets its own notice too", async () => {
    pair({ status: "completed", _count: { results: 2 } });
    serviceCapMock.mockResolvedValue(FULL);
    expect(await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW })).toEqual({
      ok: false,
      reason: "LIMIT_REACHED",
      noticeFor: "story-1",
    });
  });

  describe("a re-run finds the half refused", () => {
    it("both halves' results failed with the cap: the feed's notice, from either half", async () => {
      pair({ status: "failed", _count: { results: 1 } });
      stored({ "job-1": REFUSED, "story-1": REFUSED });
      for (const id of ["story-1", "job-1"]) {
        expect(await prepareDeferredPostJobDispatch(id, { serviceCapAt: NOW })).toEqual({
          ok: false,
          reason: "LIMIT_REACHED",
          noticeFor: "job-1",
        });
      }
      expect(resultFindManyMock).toHaveBeenCalledWith({ where: { postJobId: "job-1" }, select: { status: true, errorCode: true } });
    });

    it("the feed sent (or cancelled, no results): the Story's own notice, every re-run", async () => {
      pair({ status: "completed", _count: { results: 1 } });
      stored({ "job-1": [{ status: "success", errorCode: null }], "story-1": REFUSED });
      for (let run = 0; run < 2; run += 1) {
        expect(await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW })).toMatchObject({ noticeFor: "story-1" });
      }
      pair({ status: "cancelled", _count: { results: 0 } });
      stored({ "story-1": REFUSED });
      expect(await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW })).toMatchObject({ noticeFor: "story-1" });
    });

    it("the feed failed for another reason: the Story was refused alone", async () => {
      pair({ status: "failed", _count: { results: 1 } });
      stored({ "job-1": [{ status: "failed", errorCode: "RECONNECT_REQUIRED" }], "story-1": REFUSED });
      expect(await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW })).toMatchObject({ noticeFor: "story-1" });
    });
  });

  // Point 2: what this call's recordSend wrote travels with the answer.
  it("answers the sends its recordSend wrote, with their day, for the caller to take back", async () => {
    pair(null);
    recordSendMock.mockResolvedValue(["job-1"]);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(result).toMatchObject({ ok: true, sendsWritten: { postJobIds: ["job-1"], day: NOW } });
  });

  it("answers no sends when recordSend wrote none (a send already there for the day)", async () => {
    pair(null);
    recordSendMock.mockResolvedValue([]);
    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });
    expect(result.ok && result.sendsWritten).toBeFalsy();
  });

  it("never takes a send back itself: only the caller knows what its attempt wrote", async () => {
    pair({ status: "in_progress", _count: { results: 1 } });
    connectionFindManyMock.mockResolvedValue([]);
    await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });
    postJobFindUniqueMock.mockResolvedValue(makeJob({ publishMetadata: { targetPlatforms: ["instagram"] } }));
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: true }]);
    await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });
});

// R7-publishing L1: a paused or plan-ended workspace's due post is failed in
// prepare with its own sentence, before any cap check: no run is recorded.
describe("prepareDeferredPostJobDispatch for a blocked workspace", () => {
  const NOW = new Date("2026-11-14T15:00:00Z");
  const connections = [
    { id: "c-x", platform: "x", needsReconnect: false },
    { id: "c-ig", platform: "instagram", needsReconnect: true },
  ];
  const target = { publishMetadata: { targetPlatforms: ["x", "instagram"] } };

  it("paused: every platform that would publish gets the paused sentence; no cap check, no run", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ ...target, workspace: { pausedAt: NOW, pausedReason: null } }));
    connectionFindManyMock.mockResolvedValue(connections);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(result).toEqual({ ok: false, reason: "BLOCKED" });
    const rows = resultCreateManyMock.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({
      platform: "x",
      status: "failed",
      errorCode: "WORKSPACE_PAUSED",
      errorMessage: "Not published: this workspace was paused.",
    });
    // A platform already failed for its own reason keeps it.
    expect(rows[1]).toMatchObject({ platform: "instagram", errorCode: "RECONNECT_REQUIRED" });
    expect(recomputeMock).toHaveBeenCalledWith("job-1");
    expect(serviceCapMock).not.toHaveBeenCalled();
    expect(recordSendMock).not.toHaveBeenCalled();
  });

  it("plan ended (billing on): the no-active-plan sentence", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ ...target, workspace: { billingExempt: false, trialEndsAt: new Date("2026-11-01T00:00:00Z") } }),
    );
    connectionFindManyMock.mockResolvedValue(connections);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(result).toEqual({ ok: false, reason: "BLOCKED" });
    expect(resultCreateManyMock.mock.calls[0][0].data[0]).toMatchObject({
      errorCode: "PLAN_ENDED",
      errorMessage: "Not published: this workspace has no active plan.",
    });
    expect(serviceCapMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("a re-run that finds the blocked results refuses again and writes nothing", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ ...target, workspace: { pausedAt: NOW } }));
    connectionFindManyMock.mockResolvedValue(connections);
    resultCountMock.mockResolvedValue(2);
    resultFindManyMock.mockResolvedValue([
      { status: "failed", errorCode: "WORKSPACE_PAUSED" },
      { status: "failed", errorCode: "RECONNECT_REQUIRED" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW });

    expect(result).toEqual({ ok: false, reason: "BLOCKED" });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
    expect(recordSendMock).not.toHaveBeenCalled();
  });

  it("a workspace that is not blocked sends as before", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ ...target, workspace: { pausedAt: null } }));
    connectionFindManyMock.mockResolvedValue(connections);

    await expect(prepareDeferredPostJobDispatch("job-1", { serviceCapAt: NOW })).resolves.toMatchObject({ ok: true });
    expect(serviceCapMock).toHaveBeenCalledTimes(1);
  });
});

// R7-publishing L2: the other half of a pair joins the unit only when its
// connections give it something to send.
describe("a pair whose other half has nothing to send", () => {
  const NOW = new Date("2026-11-14T15:00:00Z");

  it("the half that can go is checked alone (one place, not two)", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob({ id: "story-1", storyOfPostJobId: "job-1", publishMetadata: { targetPlatforms: ["instagram"] } }));
    connectionFindManyMock.mockResolvedValue([
      { id: "c-ig", platform: "instagram", needsReconnect: false },
      { id: "c-fb", platform: "facebook_page", needsReconnect: true },
    ]);
    // The feed's only platform needs reconnecting.
    postJobFindUniqueMock.mockImplementation(async ({ where, select }: { where: { id: string }; select?: unknown }) =>
      select
        ? { id: "job-1", status: "in_progress", publishMetadata: { targetPlatforms: ["facebook_page"] }, mediaItem: { mimeType: "image/jpeg" }, _count: { results: 0 } }
        : makeJob({ id: where.id, storyOfPostJobId: "job-1", publishMetadata: { targetPlatforms: ["instagram"] } }),
    );

    const result = await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1"], now: NOW, recorded: true });
    expect(recordSendMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1"], at: NOW });
    expect(result.ok).toBe(true);
  });

  it("an other half with a platform to send still joins the unit", async () => {
    postJobFindUniqueMock.mockImplementation(async ({ where, select }: { where: { id: string }; select?: unknown }) =>
      select
        ? { id: "job-1", status: "in_progress", publishMetadata: { targetPlatforms: ["instagram"] }, mediaItem: { mimeType: "image/jpeg" }, _count: { results: 0 } }
        : makeJob({ id: where.id, storyOfPostJobId: "job-1", publishMetadata: { targetPlatforms: ["instagram"] } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: false }]);

    await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1", "job-1"], now: NOW, recorded: true });
  });
});

// R8-publishing L1: no split inside one scan.
describe("a pair half whose run its partner recorded", () => {
  const NOW = new Date("2026-11-14T15:00:00Z");
  const FULL = {
    errorCode: "SERVICE_DAILY_POST_LIMIT",
    errorMessage:
      "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.",
  };

  /** The Story's turn after its feed passed: the feed has its results, the Story's run is already there. */
  function storyAfterFeedPassed() {
    postJobFindUniqueMock.mockImplementation(async ({ where, select }: { where: { id: string }; select?: unknown }) =>
      select
        ? { id: "job-1", status: "in_progress", publishMetadata: null, mediaItem: { mimeType: "image/jpeg" }, _count: { results: 1 } }
        : makeJob({ id: where.id, storyOfPostJobId: "job-1" }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: false }]);
  }

  it("is not checked again, even when the pool filled up between the halves", async () => {
    storyAfterFeedPassed();
    sendRecordedMock.mockResolvedValue(true);
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

    expect(sendRecordedMock).toHaveBeenCalledWith("story-1", NOW);
    expect(serviceCapMock).not.toHaveBeenCalled();
    expect(withdrawSendMock).not.toHaveBeenCalled();
    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [{ postJobId: "story-1", workspaceId: "workspace-1", platform: "instagram", socialConnectionId: "c-ig", status: "pending" }],
    });
    expect(result.ok).toBe(true);
  });

  it("a half with no run recorded yet is checked alone, as before", async () => {
    storyAfterFeedPassed();
    serviceCapMock.mockResolvedValue(FULL);

    const result = await prepareDeferredPostJobDispatch("story-1", { serviceCapAt: NOW });

    expect(serviceCapMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", postJobIds: ["story-1"], now: NOW, recorded: true });
    expect(result).toEqual({ ok: false, reason: "LIMIT_REACHED", noticeFor: "story-1" });
  });
});

// R8-publishing L2: the rule unsentPairHalf uses, for the limit check of a pair going out now.
describe("deferredPostCanSend", () => {
  it("is true when a result it would get now is pending, by the post's own targets and media", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ id: "story-1", publishMetadata: { targetPlatforms: ["instagram"] }, mediaItem: { mimeType: "image/jpeg" } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: false }]);
    await expect(deferredPostCanSend("story-1")).resolves.toBe(true);
    expect(connectionFindManyMock).toHaveBeenCalledWith({ where: { workspaceId: "workspace-1" } });
  });

  it("is false when its platform needs reconnecting or is gone, or the post no longer exists", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({ id: "story-1", publishMetadata: { targetPlatforms: ["instagram"] }, mediaItem: { mimeType: "image/jpeg" } }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-ig", platform: "instagram", needsReconnect: true }]);
    await expect(deferredPostCanSend("story-1")).resolves.toBe(false);
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x", needsReconnect: false }]);
    await expect(deferredPostCanSend("story-1")).resolves.toBe(false);
    postJobFindUniqueMock.mockResolvedValue(null);
    await expect(deferredPostCanSend("story-1")).resolves.toBe(false);
  });

  it("counts it when it cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    postJobFindUniqueMock.mockRejectedValue(new Error("db down"));
    await expect(deferredPostCanSend("story-1")).resolves.toBe(true);
  });
});
