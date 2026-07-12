import type { MediaItem, SocialConnection } from "@prisma/client";
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
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  mediaItemCreateMock: vi.fn(),
  mediaItemUpdateMock: vi.fn(),
  findManyConnectionsMock: vi.fn(),
  postJobCreateMock: vi.fn(),
  postJobResultCreateMock: vi.fn(),
  executeRawMock: vi.fn(),
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
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

import {
  assertMediaItemReusable,
  buildPostJobCreateData,
  buildPublishMetadataSnapshot,
  createPostJobForExistingMedia,
  createPostJobOnly,
  MediaItemUnavailableError,
} from "./posting";

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.jpg",
    originalFilename: "foo.jpg",
    mimeType: "image/jpeg",
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
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.jpg",
    originalFilename: "foo.jpg",
    mimeType: "image/jpeg",
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
      where: { workspaceId: "workspace-1" },
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
      where: { workspaceId: "workspace-1" },
    });

    // Skips MediaItem creation entirely — no `prisma.mediaItem.create` mock
    // even exists here, so any call to it would throw "not a function".
    // Roadmap Phase 5: the create data now comes from buildPostJobCreateData;
    // for the default (immediate) intent it adds scheduledFor/baseCaption = null
    // (caption travels in the event payload for immediate posts, not on the row).
    expect(postJobCreateMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        mediaItemId: "media-1",
        status: "in_progress",
        scheduledFor: null,
        baseCaption: null,
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

  it("does NOT persist publishMetadata for an immediate job (it rides the event instead)", () => {
    const data = buildPostJobCreateData({
      userId: "u", mediaItemId: "m", intent: "immediate",
      scheduledFor: null, baseCaption: "hi", youtubeMetadata: yt,
    });
    expect(data.status).toBe("in_progress");
    expect(data.baseCaption).toBeNull();
    expect(data.publishMetadata).toBeUndefined();
  });
});
