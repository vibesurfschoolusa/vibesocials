import type { MediaItem, Platform, SocialConnection } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / googleTokens.test.ts). posting.ts imports
// `@/lib/db` (a real `new PrismaClient()`) at module scope, so it must be
// mocked before posting.ts is imported below. Team Workspaces (Task 5):
// posting.ts no longer imports `@/lib/workspace` — every create-helper takes
// `workspaceId` as an explicit param instead of resolving it internally.
const {
  findUniqueMock,
  mediaItemCreateMock,
  mediaItemUpdateMock,
  findManyConnectionsMock,
  postJobCreateMock,
  postJobResultCreateMock,
  executeRawMock,
  postJobMediaCreateManyMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  mediaItemCreateMock: vi.fn(),
  mediaItemUpdateMock: vi.fn(),
  findManyConnectionsMock: vi.fn(),
  postJobCreateMock: vi.fn(),
  postJobResultCreateMock: vi.fn(),
  executeRawMock: vi.fn(),
  postJobMediaCreateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  // The reuse helper runs its writes inside `prisma.$transaction(cb)` after a
  // `$executeRaw` FOR UPDATE lock; the mock invokes the callback with the same
  // client, so `tx.<model>.<op>` resolves to these same mocks.
  const prisma: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    mediaItem: {
      create: mediaItemCreateMock,
      findUnique: findUniqueMock,
      update: mediaItemUpdateMock,
    },
    socialConnection: {
      findMany: findManyConnectionsMock,
    },
    postJob: {
      create: postJobCreateMock,
    },
    postJobResult: {
      create: postJobResultCreateMock,
    },
    postJobMedia: {
      createMany: postJobMediaCreateManyMock,
    },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

import {
  assertMediaItemReusable,
  buildPostJobCreateData,
  buildPublishEvent,
  buildPublishMetadataSnapshot,
  buildRetryEvent,
  createPostJobForExistingMedia,
  createPostJobOnly,
  MediaItemUnavailableError,
  resolvePlatformCaptions,
  resolvePostCaptionSource,
} from "./posting";
import { PostTargetingError } from "@/lib/postTargets";

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.mp4",
    originalFilename: "foo.mp4",
    // A VIDEO by default: the fan-out tests use youtube/tiktok connections, and
    // since the 2026-11-01 audit a platform whose client rejects the media type
    // is refused / skipped. Video is accepted by every platform except
    // facebook_page; tests about compatibility set mimeType explicitly.
    mimeType: "video/mp4",
    sizeBytes: 1024,
    baseCaption: "Original caption",
    perPlatformOverrides: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "x",
    accessToken: "token",
    refreshToken: null,
    expiresAt: null,
    accountIdentifier: "acct-1",
    scopes: null,
    metadata: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// Team Workspaces (Task 5) — assertMediaItemReusable is now WORKSPACE-scoped,
// not uploader-scoped: reuse is allowed across members of the same
// workspace, and rejected across workspaces regardless of who uploaded.
describe("assertMediaItemReusable (pure workspace/deletedAt guard)", () => {
  it("throws NOT_FOUND when the item is null (no such row)", () => {
    expect(() => assertMediaItemReusable(null, "workspace-1")).toThrow(
      MediaItemUnavailableError,
    );
    try {
      assertMediaItemReusable(null, "workspace-1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaItemUnavailableError);
      expect((error as MediaItemUnavailableError).code).toBe("NOT_FOUND");
    }
  });

  it("throws NOT_FOUND (not a leaked 'exists but not yours') when the item belongs to a different workspace", () => {
    try {
      assertMediaItemReusable(
        { workspaceId: "someone-elses-workspace", deletedAt: null },
        "workspace-1",
      );
      expect.unreachable();
    } catch (error) {
      expect((error as MediaItemUnavailableError).code).toBe("NOT_FOUND");
    }
  });

  it("throws MEDIA_DELETED when the item is in-workspace but soft-deleted", () => {
    try {
      assertMediaItemReusable(
        { workspaceId: "workspace-1", deletedAt: new Date("2026-01-01T00:00:00Z") },
        "workspace-1",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaItemUnavailableError);
      expect((error as MediaItemUnavailableError).code).toBe("MEDIA_DELETED");
    }
  });

  it("does not throw for an in-workspace, non-deleted item", () => {
    expect(() =>
      assertMediaItemReusable({ workspaceId: "workspace-1", deletedAt: null }, "workspace-1"),
    ).not.toThrow();
  });
});

describe("createPostJobOnly (Task 7 — per-post platform targeting)", () => {
  const media = {
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.mp4",
    originalFilename: "foo.mp4",
    // Video: accepted by every platform these tests fan out to (see makeMediaItem).
    mimeType: "video/mp4",
    sizeBytes: 1024,
  };

  beforeEach(() => {
    mediaItemCreateMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();

    mediaItemCreateMock.mockResolvedValue(makeMediaItem());
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
  });

  it("targetPlatforms narrows the fan-out to only the matching connection", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
      makeConnection({ id: "conn-tt", platform: "tiktok" }),
    ]);

    const result = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media,
      baseCaption: "hello",
      targetPlatforms: ["youtube"],
    });

    expect(postJobResultCreateMock).toHaveBeenCalledTimes(1);
    expect(postJobResultCreateMock).toHaveBeenCalledWith({
      data: {
        postJobId: "job-1",
        // 2026-11-01 scale audit (db M5): the denormalized workspace, so
        // publish-health reads a workspace-scoped index instead of joining PostJob.
        workspaceId: "workspace-1",
        platform: "youtube",
        socialConnectionId: "conn-yt",
        status: "pending",
      },
    });
    expect(result.resultIds).toEqual(["result-youtube"]);
  });

  it("throws NO_CONNECTIONS when targetPlatforms excludes every connected platform", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    await expect(
      createPostJobOnly({
        userId: "user-1",
        workspaceId: "workspace-1",
        media,
        baseCaption: "hello",
        targetPlatforms: ["x"],
      }),
    ).rejects.toThrow("NO_CONNECTIONS");

    expect(mediaItemCreateMock).not.toHaveBeenCalled();
    expect(postJobCreateMock).not.toHaveBeenCalled();
    expect(postJobResultCreateMock).not.toHaveBeenCalled();
  });

  it("targetPlatforms undefined creates a result for every connection (legacy behavior preserved)", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-x", platform: "x" }),
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    const result = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media,
      baseCaption: "hello",
    });

    expect(postJobResultCreateMock).toHaveBeenCalledTimes(2);
    expect(result.resultIds).toEqual(["result-x", "result-youtube"]);
    // Every result of the fan-out carries the workspace, not just the first.
    expect(postJobResultCreateMock.mock.calls.map(([arg]) => arg.data.workspaceId)).toEqual([
      "workspace-1",
      "workspace-1",
    ]);
  });

  // Team Workspaces (Task 5): pin the workspaceId stamping on BOTH rows this
  // helper creates — now the caller's EXPLICIT param, not something resolved
  // internally — and pin the connection fan-out to the SAME workspaceId, so a
  // regression that drops the stamp or reverts the fan-out to `userId` fails
  // here, mirroring the createPostJobForExistingMedia assertion further down.
  it("stamps the passed workspaceId on both the MediaItem and the PostJob, and fans out connections by workspaceId", async () => {
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media,
      baseCaption: "hello",
    });

    expect(findManyConnectionsMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", needsReconnect: false },
    });
    expect(mediaItemCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
    });
    expect(postJobCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
    });
  });

  it("snapshots the post's Google options on the job (2026-11-10)", async () => {
    const googleMetadata = {
      postType: "offer" as const,
      offer: { title: "Deal", startDate: "2030-01-01", endDate: "2030-01-02" },
    };

    await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: { ...media, mimeType: "image/jpeg" },
      baseCaption: "hello",
      intent: "draft",
      googleMetadata,
    });

    expect(postJobCreateMock.mock.calls[0][0].data.publishMetadata).toEqual({
      googleBusinessProfile: googleMetadata,
    });
  });

});

describe("createPostJobForExistingMedia", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    mediaItemUpdateMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();

    mediaItemUpdateMock.mockResolvedValue(makeMediaItem());
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
  });

  // Team Workspaces (Task 5): reuse eligibility is now WORKSPACE-scoped, not
  // uploader-scoped — a different workspace 404s regardless of userId.
  it("throws MediaItemUnavailableError (NOT_FOUND) and never creates a PostJob when the item belongs to a different workspace", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ workspaceId: "someone-elses-workspace" }));

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(postJobCreateMock).not.toHaveBeenCalled();
    expect(findManyConnectionsMock).not.toHaveBeenCalled();
  });

  // Complement of the above: a DIFFERENT uploader in the SAME workspace must
  // be allowed to reuse the item — proves the guard checks workspace
  // membership, not who originally uploaded it (design §1 permission matrix:
  // any member may use the shared library).
  it("allows reuse when the item was uploaded by a different workspace member, as long as the workspace matches", async () => {
    findUniqueMock.mockResolvedValue(
      makeMediaItem({ userId: "teammate-2", workspaceId: "workspace-1" }),
    );
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1", // acting member, NOT the item's uploader
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    expect(result.postJobId).toBe("job-1");
    expect(postJobCreateMock).toHaveBeenCalled();
  });

  it("snapshots the post's Google options on the reuse job (2026-11-10)", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ workspaceId: "workspace-1" }));
    const googleMetadata = { postType: "update" as const, button: { type: "CALL" as const } };

    await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      intent: "scheduled",
      scheduledFor: new Date("2030-01-01T00:00:00Z"),
      googleMetadata,
    });

    expect(postJobCreateMock.mock.calls[0][0].data.publishMetadata).toEqual({
      googleBusinessProfile: googleMetadata,
    });
  });

  it("throws MediaItemUnavailableError and never creates a PostJob when the item was deleted", async () => {
    findUniqueMock.mockResolvedValue(
      makeMediaItem({ deletedAt: new Date("2026-02-01T00:00:00Z") }),
    );

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DELETED" });

    expect(postJobCreateMock).not.toHaveBeenCalled();
  });

  it("throws NO_CONNECTIONS and never creates a PostJob when the workspace has no social connections", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([]);

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toThrow("NO_CONNECTIONS");

    expect(postJobCreateMock).not.toHaveBeenCalled();
  });

  // Team Workspaces (Task 5) — the in-transaction row-locked re-check must
  // read the SAME field the pre-check uses (workspaceId), not the retired
  // userId, or a regression here would silently re-open the uploader-only
  // guard under concurrent load.
  it("re-checks the row-locked media item by workspaceId (not userId)", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    // First call is the pre-transaction existence check; second is the
    // in-transaction lock re-check inside `$transaction`.
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
    const lockedCall = findUniqueMock.mock.calls[1][0] as {
      select: Record<string, boolean>;
    };
    expect(lockedCall.select).toEqual({ workspaceId: true, deletedAt: true });
  });

  it("creates a PostJob + one PostJobResult per connection, referencing the existing mediaItemId", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-x", platform: "x" }),
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    expect(result).toEqual({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: ["result-x", "result-youtube"],
    });

    expect(findManyConnectionsMock).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", needsReconnect: false },
    });

    // Skips MediaItem creation entirely — no `prisma.mediaItem.create` mock
    // even exists here, so any call to it would throw "not a function".
    // Roadmap Phase 5: the create data now comes from buildPostJobCreateData;
    // for the default (immediate) intent scheduledFor stays null. 2026-11-01
    // audit: the caption typed for THIS post is snapshotted on the job (a
    // reuse never rewrites the shared MediaItem's "Original caption").
    expect(postJobCreateMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        mediaItemId: "media-1",
        status: "in_progress",
        scheduledFor: null,
        baseCaption: "hello",
        // Team Workspaces (Task 5) — the caller's explicit workspaceId param.
        workspaceId: "workspace-1",
      },
    });
    expect(postJobResultCreateMock).toHaveBeenCalledTimes(2);
  });

  it("stamps lastUsedAt = now on the existing row and does NOT touch metadata when location is omitted", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    const before = Date.now();
    await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });
    const after = Date.now();

    expect(mediaItemUpdateMock).toHaveBeenCalledTimes(1);
    const call = mediaItemUpdateMock.mock.calls[0][0] as {
      where: { id: string };
      data: { lastUsedAt: Date; metadata?: unknown };
    };
    expect(call.where).toEqual({ id: "media-1" });
    expect(call.data.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(call.data.lastUsedAt.getTime()).toBeLessThanOrEqual(after);
    expect(call.data).not.toHaveProperty("metadata");
  });

  it("writes metadata.location onto the existing row when location IS supplied", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      location: "Miami Beach, FL",
    });

    const call = mediaItemUpdateMock.mock.calls[0][0] as {
      data: { metadata?: { location?: { description: string } } };
    };
    expect(call.data.metadata).toEqual({ location: { description: "Miami Beach, FL" } });
  });

  it("passes the mediaItemId (not a new id) through as both the lookup key and the returned mediaItemId", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ id: "media-999" }));
    findManyConnectionsMock.mockResolvedValue([makeConnection()]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-999",
      baseCaption: "hello",
    });

    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "media-999" } });
    expect(result.mediaItemId).toBe("media-999");
  });
});

describe("createPostJobForExistingMedia (Task 7 — per-post platform targeting)", () => {
  // Same trio as the createPostJobOnly targeting block above, against the
  // reuse path (Task 7 review fix: posting.ts's `targeted` filter +
  // NO_CONNECTIONS throw + result creation exist independently in BOTH create
  // helpers, so both need coverage). Mirrors the reuse-path mock conventions
  // of the createPostJobForExistingMedia block above (mediaItem findUnique
  // feeds both the pre-check and the in-transaction locked re-check; the
  // $transaction mock at the top of this file replays the callback against
  // the same mocked client, with $executeRaw as a plain vi.fn()).
  beforeEach(() => {
    findUniqueMock.mockReset();
    mediaItemUpdateMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();

    findUniqueMock.mockResolvedValue(makeMediaItem());
    mediaItemUpdateMock.mockResolvedValue(makeMediaItem());
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
  });

  it("targetPlatforms narrows the reuse fan-out to only the matching connection", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
      makeConnection({ id: "conn-tt", platform: "tiktok" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      targetPlatforms: ["youtube"],
    });

    expect(postJobResultCreateMock).toHaveBeenCalledTimes(1);
    expect(postJobResultCreateMock).toHaveBeenCalledWith({
      data: {
        postJobId: "job-1",
        // 2026-11-01 scale audit (db M5): the denormalized workspace, so
        // publish-health reads a workspace-scoped index instead of joining PostJob.
        workspaceId: "workspace-1",
        platform: "youtube",
        socialConnectionId: "conn-yt",
        status: "pending",
      },
    });
    expect(result.resultIds).toEqual(["result-youtube"]);
  });

  it("throws NO_CONNECTIONS when targetPlatforms excludes every connected platform (reuse path)", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        workspaceId: "workspace-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
        targetPlatforms: ["x"],
      }),
    ).rejects.toThrow("NO_CONNECTIONS");

    // The throw happens before the transaction, so nothing was written: no
    // job row, no result rows, and the media item wasn't touched either.
    expect(postJobCreateMock).not.toHaveBeenCalled();
    expect(postJobResultCreateMock).not.toHaveBeenCalled();
    expect(mediaItemUpdateMock).not.toHaveBeenCalled();
  });

  it("targetPlatforms undefined creates a result for every connection (legacy reuse behavior preserved)", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-x", platform: "x" }),
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    expect(postJobResultCreateMock).toHaveBeenCalledTimes(2);
    expect(result.resultIds).toEqual(["result-x", "result-youtube"]);
    // Every result of the fan-out carries the workspace, not just the first.
    expect(postJobResultCreateMock.mock.calls.map(([arg]) => arg.data.workspaceId)).toEqual([
      "workspace-1",
      "workspace-1",
    ]);
  });
});

describe("buildPublishMetadataSnapshot (review B1)", () => {
  const yt = { privacyStatus: "private" } as const;
  const tt = { privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false };

  it("returns undefined when neither platform has metadata", () => {
    expect(buildPublishMetadataSnapshot(undefined, undefined)).toBeUndefined();
  });

  it("includes only the platforms that have metadata", () => {
    expect(buildPublishMetadataSnapshot(undefined, yt)).toEqual({ youtube: yt });
    expect(buildPublishMetadataSnapshot(tt, undefined)).toEqual({ tiktok: tt });
    expect(buildPublishMetadataSnapshot(tt, yt)).toEqual({ tiktok: tt, youtube: yt });
  });

  // Task 7 — third positional param: chosen subset of platforms to publish to.
  it("returns undefined when all three args are absent/empty", () => {
    expect(buildPublishMetadataSnapshot(undefined, undefined, undefined)).toBeUndefined();
  });

  it("includes targetPlatforms alone when only it is provided", () => {
    expect(buildPublishMetadataSnapshot(undefined, undefined, ["x"])).toEqual({
      targetPlatforms: ["x"],
    });
  });

  // 2026-11-10 — fourth positional param: the Google post's options.
  it("includes the Google options under googleBusinessProfile", () => {
    const google = { postType: "update" as const };
    expect(buildPublishMetadataSnapshot(undefined, undefined, undefined, google)).toEqual({
      googleBusinessProfile: google,
    });
    expect(buildPublishMetadataSnapshot(undefined, yt, ["youtube"], google)).toEqual({
      youtube: yt,
      targetPlatforms: ["youtube"],
      googleBusinessProfile: google,
    });
  });

  it("includes targetPlatforms alongside tiktok metadata", () => {
    expect(buildPublishMetadataSnapshot(tt, undefined, ["tiktok", "x"])).toEqual({
      tiktok: tt,
      targetPlatforms: ["tiktok", "x"],
    });
  });
});

describe("buildPostJobCreateData (review B1 — persist deferred privacy)", () => {
  const yt = { privacyStatus: "private" } as const;

  it("persists publishMetadata for a scheduled job (and sets scheduledFor/baseCaption)", () => {
    const when = new Date("2030-01-01T00:00:00Z");
    const data = buildPostJobCreateData({
      userId: "u", mediaItemId: "m", intent: "scheduled",
      scheduledFor: when, baseCaption: "hi", youtubeMetadata: yt,
    });
    expect(data.status).toBe("scheduled");
    expect(data.scheduledFor).toBe(when);
    expect(data.baseCaption).toBe("hi");
    expect(data.publishMetadata).toEqual({ youtube: yt });
  });

  it("persists publishMetadata for a draft job", () => {
    const data = buildPostJobCreateData({
      userId: "u", mediaItemId: "m", intent: "draft",
      scheduledFor: null, baseCaption: "hi", youtubeMetadata: yt,
    });
    expect(data.status).toBe("draft");
    expect(data.publishMetadata).toEqual({ youtube: yt });
  });

  it("persists publishMetadata for an immediate job so retry can replay privacy", () => {
    const data = buildPostJobCreateData({
      userId: "u", mediaItemId: "m", intent: "immediate",
      scheduledFor: null, baseCaption: "hi", youtubeMetadata: yt,
    });
    expect(data.status).toBe("in_progress");
    expect(data.publishMetadata).toEqual({ youtube: yt });
  });
});

// 2026-11-01 audit (Task 4 item 1): EVERY job snapshots its own caption, so a
// retry (and YouTube's title) use the text typed for THIS post — not the
// shared MediaItem's, which a reuse never rewrites. `scheduledFor` stays
// scheduled-only.
describe("buildPostJobCreateData — caption snapshot for every intent", () => {
  const overrides = { x: "X-only text" };

  it.each(["immediate", "scheduled", "draft"] as const)(
    "%s: snapshots baseCaption + perPlatformOverrides onto the job",
    (intent) => {
      const data = buildPostJobCreateData({
        userId: "u", mediaItemId: "m", intent,
        scheduledFor: new Date("2030-01-01T00:00:00Z"),
        baseCaption: "typed for this post", perPlatformOverrides: overrides,
      });
      expect(data.baseCaption).toBe("typed for this post");
      expect(data.perPlatformOverrides).toEqual(overrides);
    },
  );

  it("leaves perPlatformOverrides unset when the post has none", () => {
    const data = buildPostJobCreateData({
      userId: "u", mediaItemId: "m", intent: "immediate",
      scheduledFor: null, baseCaption: "hi", perPlatformOverrides: null,
    });
    expect(data.perPlatformOverrides).toBeUndefined();
  });

  it("keeps scheduledFor gated on the scheduled intent", () => {
    const when = new Date("2030-01-01T00:00:00Z");
    for (const intent of ["immediate", "draft"] as const) {
      const data = buildPostJobCreateData({
        userId: "u", mediaItemId: "m", intent, scheduledFor: when, baseCaption: "hi",
      });
      expect(data.scheduledFor).toBeNull();
    }
  });
});

describe("resolvePostCaptionSource — the job's snapshot as a unit, media item only for legacy jobs", () => {
  const media = { baseCaption: "Media caption", perPlatformOverrides: { x: "media X" } };

  it("uses the job's own caption and overrides when it has them", () => {
    expect(
      resolvePostCaptionSource(
        { baseCaption: "Job caption", perPlatformOverrides: { x: "job X" } },
        media,
      ),
    ).toEqual({ baseCaption: "Job caption", perPlatformOverrides: { x: "job X" } });
  });

  // Fix round 1 (review IMPORTANT #1): a job with its own caption snapshot
  // and null overrides means "no overrides" (never set, or cleared by PATCH)
  // — the shared media item's overrides from the first upload must NOT come
  // back.
  it("a job with a caption snapshot and null overrides uses NO overrides, even if the media item has some", () => {
    expect(
      resolvePostCaptionSource({ baseCaption: "Job caption", perPlatformOverrides: null }, media),
    ).toEqual({ baseCaption: "Job caption", perPlatformOverrides: null });
  });

  it("a legacy job with no snapshot (null caption) falls back to the media item's caption AND overrides", () => {
    expect(
      resolvePostCaptionSource({ baseCaption: null, perPlatformOverrides: null }, media),
    ).toEqual({ baseCaption: "Media caption", perPlatformOverrides: { x: "media X" } });
  });

  it("returns null overrides when neither has any", () => {
    expect(
      resolvePostCaptionSource(
        { baseCaption: "Job caption", perPlatformOverrides: null },
        { baseCaption: "Media caption", perPlatformOverrides: null },
      ),
    ).toEqual({ baseCaption: "Job caption", perPlatformOverrides: null });
  });
});

// 2026-11-01 audit (M1): an owner approves what will PUBLISH, so the per-platform
// texts shown to them come from the very same caption source the publish path
// uses (resolvePostCaptionSource), narrowed to the platforms that will post.
describe("resolvePlatformCaptions — the override texts the publish path will use (2026-11-01 audit, M1)", () => {
  const media = { baseCaption: "Media caption", perPlatformOverrides: { x: "media X" } };
  const job = (overrides: Record<string, unknown> = {}) => ({
    baseCaption: "Job caption",
    perPlatformOverrides: { linkedin: "Hidden text" },
    ...overrides,
  });

  it("returns the job's override texts", () => {
    expect(resolvePlatformCaptions(job(), media)).toEqual({ linkedin: "Hidden text" });
  });

  it("is null when the job has no overrides (null or an empty object)", () => {
    expect(resolvePlatformCaptions(job({ perPlatformOverrides: null }), media)).toBeNull();
    expect(resolvePlatformCaptions(job({ perPlatformOverrides: {} }), media)).toBeNull();
  });

  it("never resurrects the media item's overrides for a job with its own caption snapshot", () => {
    // Same snapshot-as-a-unit rule as resolvePostCaptionSource: null = none.
    expect(resolvePlatformCaptions(job({ perPlatformOverrides: null }), media)).toBeNull();
  });

  it("a legacy job with no snapshot (null caption) takes the media item's overrides", () => {
    expect(
      resolvePlatformCaptions({ baseCaption: null, perPlatformOverrides: null }, media),
    ).toEqual({ x: "media X" });
  });

  it("tolerates a missing media item row", () => {
    expect(resolvePlatformCaptions(job(), null)).toEqual({ linkedin: "Hidden text" });
    expect(
      resolvePlatformCaptions({ baseCaption: null, perPlatformOverrides: null }, undefined),
    ).toBeNull();
  });

  it("drops empty texts (the publisher falls back to the base caption for them)", () => {
    expect(
      resolvePlatformCaptions(job({ perPlatformOverrides: { linkedin: "", x: "Kept" } }), media),
    ).toEqual({ x: "Kept" });
    expect(
      resolvePlatformCaptions(job({ perPlatformOverrides: { linkedin: "" } }), media),
    ).toBeNull();
  });

  it("ignores keys that are not platforms (the publisher never reads them)", () => {
    expect(
      resolvePlatformCaptions(
        job({ perPlatformOverrides: { myspace: "Inert", linkedin: "Hidden text" } }),
        media,
      ),
    ).toEqual({ linkedin: "Hidden text" });
  });

  describe("target platforms", () => {
    const overrides = { linkedin: "LinkedIn text", x: "X text", youtube: "YouTube text" };

    it("keeps only the platforms in the job's publishMetadata.targetPlatforms", () => {
      expect(
        resolvePlatformCaptions(
          job({
            perPlatformOverrides: overrides,
            publishMetadata: { targetPlatforms: ["x", "youtube"] },
          }),
          media,
        ),
      ).toEqual({ x: "X text", youtube: "YouTube text" });
    });

    it("is null when no override belongs to a targeted platform", () => {
      expect(
        resolvePlatformCaptions(
          job({
            perPlatformOverrides: { linkedin: "LinkedIn text" },
            publishMetadata: { targetPlatforms: ["x"] },
          }),
          media,
        ),
      ).toBeNull();
    });

    it("uses the platforms of the job's results once they exist (what actually publishes / retries)", () => {
      expect(
        resolvePlatformCaptions(
          job({
            perPlatformOverrides: overrides,
            // The snapshot named three platforms, but only two results exist.
            publishMetadata: { targetPlatforms: ["linkedin", "x", "youtube"] },
            results: [{ platform: "x" }, { platform: "youtube" }],
          }),
          media,
        ),
      ).toEqual({ x: "X text", youtube: "YouTube text" });
    });

    it("treats an empty targetPlatforms and no results as 'all connections' - every override key shows", () => {
      expect(
        resolvePlatformCaptions(
          job({ perPlatformOverrides: overrides, publishMetadata: { targetPlatforms: [] }, results: [] }),
          media,
        ),
      ).toEqual(overrides);
      expect(
        resolvePlatformCaptions(job({ perPlatformOverrides: overrides, publishMetadata: null }), media),
      ).toEqual(overrides);
    });
  });
});

// 2026-11-01 audit (Task 9) - media compatibility + the TikTok privacy rule at
// the create-helper level. The stored mimeType of the media is the source of
// truth for the reuse path; the blobUrl path uses the validated upload mimeType.
describe("createPostJobOnly - media compatibility + TikTok privacy (2026-11-01 audit)", () => {
  const imageMedia = {
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.jpg",
    originalFilename: "foo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
  };
  const videoMedia = { ...imageMedia, originalFilename: "foo.mp4", mimeType: "video/mp4" };

  beforeEach(() => {
    mediaItemCreateMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();

    mediaItemCreateMock.mockResolvedValue(makeMediaItem());
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
  });

  function expectNothingCreated() {
    expect(mediaItemCreateMock).not.toHaveBeenCalled();
    expect(postJobCreateMock).not.toHaveBeenCalled();
    expect(postJobResultCreateMock).not.toHaveBeenCalled();
  }

  it("rejects an explicit list naming a platform that can't publish the media, creating nothing", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
      makeConnection({ id: "conn-x", platform: "x" }),
    ]);

    const error = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: imageMedia,
      baseCaption: "hello",
      targetPlatforms: ["youtube", "x"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PostTargetingError);
    expect((error as PostTargetingError).code).toBe("PLATFORM_MEDIA_MISMATCH");
    expect((error as PostTargetingError).platforms).toEqual(["youtube"]);
    expectNothingCreated();
  });

  it("rejects an explicit incompatible list for a SCHEDULED post too (intent doesn't matter)", async () => {
    const error = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: imageMedia,
      baseCaption: "hello",
      intent: "scheduled",
      scheduledFor: new Date(Date.now() + 3_600_000),
      targetPlatforms: ["tiktok"],
    }).catch((e: unknown) => e);

    expect((error as PostTargetingError).code).toBe("PLATFORM_MEDIA_MISMATCH");
    expect(findManyConnectionsMock).not.toHaveBeenCalled();
    expectNothingCreated();
  });

  it("skips incompatible connected platforms (no result rows) when no explicit list was sent", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
      makeConnection({ id: "conn-x", platform: "x" }),
      makeConnection({ id: "conn-fb", platform: "facebook_page" }),
      makeConnection({ id: "conn-tt", platform: "tiktok" }),
    ]);

    const result = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: imageMedia,
      baseCaption: "hello",
    });

    expect(postJobResultCreateMock.mock.calls.map(([arg]) => arg.data.platform)).toEqual([
      "x",
      "facebook_page",
    ]);
    expect(result.resultIds).toEqual(["result-x", "result-facebook_page"]);
  });

  it("throws NO_COMPATIBLE_PLATFORMS (not NO_CONNECTIONS) when connections exist but none can publish the media", async () => {
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    const error = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: imageMedia,
      baseCaption: "hello",
    }).catch((e: unknown) => e);

    expect((error as PostTargetingError).code).toBe("NO_COMPATIBLE_PLATFORMS");
    expectNothingCreated();
  });

  it("requires a TikTok privacy level whenever TikTok is an explicit target - immediate, scheduled and draft", async () => {
    findManyConnectionsMock.mockResolvedValue([makeConnection({ id: "conn-tt", platform: "tiktok" })]);

    for (const intent of ["immediate", "scheduled", "draft"] as const) {
      const error = await createPostJobOnly({
        userId: "user-1",
        workspaceId: "workspace-1",
        media: videoMedia,
        baseCaption: "hello",
        intent,
        scheduledFor: intent === "scheduled" ? new Date(Date.now() + 3_600_000) : null,
        targetPlatforms: ["tiktok"],
        tiktokMetadata: {
          privacyLevel: "",
          disableComment: true,
          disableDuet: true,
          disableStitch: true,
        },
      }).catch((e: unknown) => e);

      expect((error as PostTargetingError).code, intent).toBe("TIKTOK_PRIVACY_REQUIRED");
    }
    expectNothingCreated();
  });

  it("accepts a deferred TikTok post that carries a privacy level", async () => {
    await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: videoMedia,
      baseCaption: "hello",
      intent: "draft",
      targetPlatforms: ["tiktok"],
      tiktokMetadata: {
        privacyLevel: "SELF_ONLY",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
      },
    });

    expect(postJobCreateMock).toHaveBeenCalledTimes(1);
  });

  it("requires a TikTok privacy level for an immediate post that implicitly targets a connected TikTok", async () => {
    findManyConnectionsMock.mockResolvedValue([makeConnection({ id: "conn-tt", platform: "tiktok" })]);

    const error = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: videoMedia,
      baseCaption: "hello",
    }).catch((e: unknown) => e);

    expect((error as PostTargetingError).code).toBe("TIKTOK_PRIVACY_REQUIRED");
    expectNothingCreated();
  });
});

describe("createPostJobForExistingMedia - media compatibility uses the stored mimeType (2026-11-01 audit)", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    mediaItemUpdateMock.mockReset();
    executeRawMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();

    mediaItemUpdateMock.mockResolvedValue(makeMediaItem());
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
  });

  it("sends a stored VIDEO to an explicit Facebook Page target (Facebook takes videos since 2026-11-08)", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ mimeType: "video/mp4" }));
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-fb", platform: "facebook_page" }),
      makeConnection({ id: "conn-x", platform: "x" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      targetPlatforms: ["facebook_page", "x"],
    });

    expect(postJobResultCreateMock.mock.calls.map(([arg]) => arg.data.platform)).toEqual([
      "facebook_page",
      "x",
    ]);
    expect(result.resultIds).toEqual(["result-facebook_page", "result-x"]);
  });

  it("rejects an explicit list the stored IMAGE can't go to (YouTube is video-only)", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ mimeType: "image/png" }));

    const error = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      intent: "draft",
      targetPlatforms: ["youtube"],
    }).catch((e: unknown) => e);

    expect((error as PostTargetingError).code).toBe("PLATFORM_MEDIA_MISMATCH");
    expect(postJobCreateMock).not.toHaveBeenCalled();
  });

  it("skips incompatible connected platforms (no result rows) when no explicit list was sent", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ mimeType: "image/png" }));
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-yt", platform: "youtube" }),
      makeConnection({ id: "conn-fb", platform: "facebook_page" }),
      makeConnection({ id: "conn-x", platform: "x" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    expect(postJobResultCreateMock.mock.calls.map(([arg]) => arg.data.platform)).toEqual([
      "facebook_page",
      "x",
    ]);
    expect(result.resultIds).toEqual(["result-facebook_page", "result-x"]);
  });

  it("requires a TikTok privacy level whenever TikTok is an explicit target", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ mimeType: "video/mp4" }));

    const error = await createPostJobForExistingMedia({
      userId: "user-1",
      workspaceId: "workspace-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
      intent: "draft",
      targetPlatforms: ["tiktok"],
    }).catch((e: unknown) => e);

    expect((error as PostTargetingError).code).toBe("TIKTOK_PRIVACY_REQUIRED");
    expect(postJobCreateMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (jobs H6 + H1): a publish event carries a STABLE id so
// Inngest drops a duplicate send, plus the `immediate` flag its priority reads.
describe("buildPublishEvent", () => {
  const data = {
    postJobId: "job-1",
    userId: "user-1",
    workspaceId: "ws-1",
    mediaItemId: "media-1",
    baseCaption: "hello",
    perPlatformOverrides: null,
  };

  it("derives the event id from the job, so a re-send of the same job is a duplicate", () => {
    const event = buildPublishEvent(data, { immediate: false });

    expect(event.id).toBe("publish-job-1");
    expect(event.name).toBe("post/publish.requested");
    expect(buildPublishEvent(data, { immediate: true }).id).toBe(event.id);
  });

  it("stamps the immediate flag onto the data and keeps every other field", () => {
    expect(buildPublishEvent(data, { immediate: false }).data).toEqual({ ...data, immediate: false });
    expect(buildPublishEvent(data, { immediate: true }).data).toEqual({ ...data, immediate: true });
  });

  it("passes extra fields (the posts route's location) through unchanged", () => {
    const event = buildPublishEvent({ ...data, location: "Berlin" }, { immediate: true });

    expect(event.data.location).toBe("Berlin");
  });

  it("does not mutate its input", () => {
    const input = { ...data };
    buildPublishEvent(input, { immediate: true });

    expect(input).toEqual(data);
    expect(input).not.toHaveProperty("immediate");
  });
});

describe("buildRetryEvent", () => {
  const data = {
    postJobId: "job-1",
    userId: "user-1",
    workspaceId: "ws-1",
    platforms: ["x", "tiktok"] as Platform[],
  };

  it("makes the event id unique per request, so a second retry within 24 h is not deduplicated", () => {
    expect(buildRetryEvent(data, "abc").id).toBe("retry-job-1-abc");
    expect(buildRetryEvent(data, "def").id).toBe("retry-job-1-def");
  });

  it("carries the data as given", () => {
    const event = buildRetryEvent(data, "abc");

    expect(event.name).toBe("post/retry.requested");
    expect(event.data).toEqual(data);
  });
});

describe("createPostJobOnly - several photos (07a)", () => {
  const photo = (n: number) => ({
    storageLocation: `https://example.public.blob.vercel-storage.com/p${n}.jpg`,
    originalFilename: `p${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 100 + n,
  });

  beforeEach(() => {
    mediaItemCreateMock.mockReset();
    findManyConnectionsMock.mockReset();
    postJobCreateMock.mockReset();
    postJobResultCreateMock.mockReset();
    postJobMediaCreateManyMock.mockReset();

    let created = 0;
    mediaItemCreateMock.mockImplementation(() => {
      created += 1;
      return Promise.resolve(makeMediaItem({ id: `media-${created}`, mimeType: "image/jpeg" }));
    });
    postJobCreateMock.mockResolvedValue({ id: "job-1" });
    postJobMediaCreateManyMock.mockResolvedValue({ count: 3 });
    postJobResultCreateMock.mockImplementation((args: { data: { platform: string } }) =>
      Promise.resolve({ id: `result-${args.data.platform}` }),
    );
    findManyConnectionsMock.mockResolvedValue([makeConnection({ id: "conn-x", platform: "x" })]);
  });

  it("a single photo writes one MediaItem, the job, and no PostJobMedia rows", async () => {
    const result = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: photo(1),
      baseCaption: "hello",
    });

    expect(mediaItemCreateMock).toHaveBeenCalledTimes(1);
    expect(postJobMediaCreateManyMock).not.toHaveBeenCalled();
    expect(postJobCreateMock.mock.calls[0][0].data.mediaItemId).toBe("media-1");
    expect(result.mediaItemId).toBe("media-1");
  });

  it("three photos write three MediaItems and three ordered PostJobMedia rows, the job pointing at the first", async () => {
    const before = Date.now();
    const result = await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: photo(1),
      extraMedia: [photo(2), photo(3)],
      baseCaption: "hello",
      location: "Miami",
    });

    expect(mediaItemCreateMock).toHaveBeenCalledTimes(3);
    const created = mediaItemCreateMock.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(created.map((d) => d.storageLocation)).toEqual([
      photo(1).storageLocation,
      photo(2).storageLocation,
      photo(3).storageLocation,
    ]);
    // Each photo is its own library item in the workspace, stamped as used now.
    for (const data of created) {
      expect(data).toMatchObject({
        userId: "user-1",
        workspaceId: "workspace-1",
        mimeType: "image/jpeg",
        baseCaption: "hello",
        metadata: { location: { description: "Miami" } },
      });
      expect((data.lastUsedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    }

    expect(postJobCreateMock.mock.calls[0][0].data.mediaItemId).toBe("media-1");
    expect(postJobMediaCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", mediaItemId: "media-1", position: 0 },
        { postJobId: "job-1", mediaItemId: "media-2", position: 1 },
        { postJobId: "job-1", mediaItemId: "media-3", position: 2 },
      ],
    });
    expect(result).toEqual({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["result-x"] });
  });

  it("an empty extraMedia list is a single-photo post", async () => {
    await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: photo(1),
      extraMedia: [],
      baseCaption: "hello",
    });

    expect(mediaItemCreateMock).toHaveBeenCalledTimes(1);
    expect(postJobMediaCreateManyMock).not.toHaveBeenCalled();
  });

  it("a scheduled multi-photo post writes its rows and no results", async () => {
    await createPostJobOnly({
      userId: "user-1",
      workspaceId: "workspace-1",
      media: photo(1),
      extraMedia: [photo(2)],
      baseCaption: "hello",
      intent: "scheduled",
      scheduledFor: new Date("2030-01-01T00:00:00Z"),
    });

    expect(postJobMediaCreateManyMock).toHaveBeenCalledTimes(1);
    expect(postJobResultCreateMock).not.toHaveBeenCalled();
    expect(postJobCreateMock.mock.calls[0][0].data.status).toBe("scheduled");
  });
});
