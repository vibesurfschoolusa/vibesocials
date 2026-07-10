import type { MediaItem, SocialConnection } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / googleTokens.test.ts). posting.ts imports
// `@/lib/db` (a real `new PrismaClient()`) at module scope, so it must be
// mocked before posting.ts is imported below.
const {
  findUniqueMock,
  mediaItemUpdateMock,
  findManyConnectionsMock,
  postJobCreateMock,
  postJobResultCreateMock,
  executeRawMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
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
  MediaItemUnavailableError,
} from "./posting";

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media-1",
    userId: "user-1",
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

describe("assertMediaItemReusable (pure ownership/deletedAt guard)", () => {
  it("throws NOT_FOUND when the item is null (no such row)", () => {
    expect(() => assertMediaItemReusable(null, "user-1")).toThrow(MediaItemUnavailableError);
    try {
      assertMediaItemReusable(null, "user-1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaItemUnavailableError);
      expect((error as MediaItemUnavailableError).code).toBe("NOT_FOUND");
    }
  });

  it("throws NOT_FOUND (not a leaked 'exists but not yours') when owned by a different user", () => {
    try {
      assertMediaItemReusable({ userId: "someone-else", deletedAt: null }, "user-1");
      expect.unreachable();
    } catch (error) {
      expect((error as MediaItemUnavailableError).code).toBe("NOT_FOUND");
    }
  });

  it("throws MEDIA_DELETED when the item is owned but soft-deleted", () => {
    try {
      assertMediaItemReusable(
        { userId: "user-1", deletedAt: new Date("2026-01-01T00:00:00Z") },
        "user-1",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaItemUnavailableError);
      expect((error as MediaItemUnavailableError).code).toBe("MEDIA_DELETED");
    }
  });

  it("does not throw for an owned, non-deleted item", () => {
    expect(() =>
      assertMediaItemReusable({ userId: "user-1", deletedAt: null }, "user-1"),
    ).not.toThrow();
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

  it("throws MediaItemUnavailableError and never creates a PostJob when the item is not owned", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem({ userId: "someone-else" }));

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(postJobCreateMock).not.toHaveBeenCalled();
    expect(findManyConnectionsMock).not.toHaveBeenCalled();
  });

  it("throws MediaItemUnavailableError and never creates a PostJob when the item was deleted", async () => {
    findUniqueMock.mockResolvedValue(
      makeMediaItem({ deletedAt: new Date("2026-02-01T00:00:00Z") }),
    );

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DELETED" });

    expect(postJobCreateMock).not.toHaveBeenCalled();
  });

  it("throws NO_CONNECTIONS and never creates a PostJob when the user has no social connections", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([]);

    await expect(
      createPostJobForExistingMedia({
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "hello",
      }),
    ).rejects.toThrow("NO_CONNECTIONS");

    expect(postJobCreateMock).not.toHaveBeenCalled();
  });

  it("creates a PostJob + one PostJobResult per connection, referencing the existing mediaItemId", async () => {
    findUniqueMock.mockResolvedValue(makeMediaItem());
    findManyConnectionsMock.mockResolvedValue([
      makeConnection({ id: "conn-x", platform: "x" }),
      makeConnection({ id: "conn-yt", platform: "youtube" }),
    ]);

    const result = await createPostJobForExistingMedia({
      userId: "user-1",
      mediaItemId: "media-1",
      baseCaption: "hello",
    });

    expect(result).toEqual({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: ["result-x", "result-youtube"],
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
      mediaItemId: "media-999",
      baseCaption: "hello",
    });

    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "media-999" } });
    expect(result.mediaItemId).toBe("media-999");
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
