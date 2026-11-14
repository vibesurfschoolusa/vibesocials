import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";

import { INSTAGRAM_COVER_REFUSED_NOTE, instagramClient } from "./instagramClient";
import type { PublishContext } from "./types";

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: vi.fn(), findUnique: vi.fn() } },
}));

const COVER_URL = "https://blob.example.com/cover.jpg";

function connection(): SocialConnection {
  return {
    id: "conn-ig",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "instagram",
    accessToken: "page-access-token",
    refreshToken: null,
    expiresAt: null,
    accountIdentifier: "ig-account-1",
    scopes: null,
    metadata: { username: "acme", pageId: "page-1" },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
  } as SocialConnection;
}

function makeStore() {
  const kept = new Map<string, UploadSnapshot<unknown, unknown>>();
  return {
    load: vi.fn(async (kind: string) => kept.get(kind) ?? null),
    save: vi.fn(async (kind: string, snapshot: UploadSnapshot<unknown, unknown>) => {
      kept.set(kind, snapshot);
    }),
    clear: vi.fn(async () => {
      kept.clear();
    }),
  } as unknown as UploadStateStore;
}

function ctx(extra: Partial<PublishContext> = {}): PublishContext {
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: connection(),
    get mediaItems() {
      return [this.mediaItem];
    },
    mediaItem: {
      mimeType: "video/mp4",
      storageLocation: "https://blob.example.com/m.mp4",
      metadata: null,
    } as unknown as MediaItem,
    caption: "hello",
    ...extra,
  };
}

type Route = (url: URL) => Response;
function stubGraph(container: Route) {
  const containerCalls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/media_publish")) {
        return Promise.resolve(new Response(JSON.stringify({ id: "media-1" }), { status: 200 }));
      }
      if (url.pathname.endsWith("/ig-account-1/media")) {
        containerCalls.push(url);
        return Promise.resolve(container(url));
      }
      if (url.searchParams.get("fields") === "status_code") {
        return Promise.resolve(new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 }));
      }
      if (url.searchParams.get("fields") === "permalink") {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return containerCalls;
}

const containerOk = () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 });

/** Two steps: the container, then (its state saved) the status check and media_publish. */
async function publishAcrossSteps(context: PublishContext) {
  const store = makeStore();
  const first = await instagramClient.publishVideo({ ...context, uploadState: store, mediaItems: context.mediaItems });
  expect(first.continuation).toBeDefined();
  return instagramClient.publishVideo({ ...context, uploadState: store, mediaItems: context.mediaItems });
}

describe("instagramClient - a Reel's cover", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no cover: neither cover_url nor thumb_offset is sent", async () => {
    const calls = stubGraph(containerOk);
    await publishAcrossSteps(ctx());
    expect(calls[0].searchParams.get("cover_url")).toBeNull();
    expect(calls[0].searchParams.get("thumb_offset")).toBeNull();
  });

  it("a frame: thumb_offset in milliseconds, and no cover_url (it would win over the frame)", async () => {
    const calls = stubGraph(containerOk);
    const result = await publishAcrossSteps(ctx({ cover: { timeMs: 2500, imageUrl: COVER_URL } }));
    expect(calls[0].searchParams.get("media_type")).toBe("REELS");
    expect(calls[0].searchParams.get("thumb_offset")).toBe("2500");
    expect(calls[0].searchParams.get("cover_url")).toBeNull();
    expect(result).toEqual({ externalPostId: "media-1" });
  });

  it("an uploaded image: cover_url", async () => {
    const calls = stubGraph(containerOk);
    await publishAcrossSteps(ctx({ cover: { imageUrl: COVER_URL } }));
    expect(calls[0].searchParams.get("cover_url")).toBe(COVER_URL);
    expect(calls[0].searchParams.get("thumb_offset")).toBeNull();
  });

  it("a container refused with the cover is created once more without it; the post carries a note", async () => {
    const calls = stubGraph((url) =>
      url.searchParams.get("cover_url")
        ? new Response(JSON.stringify({ error: { message: "bad image", code: 100 } }), { status: 400 })
        : containerOk(),
    );

    const result = await publishAcrossSteps(ctx({ cover: { imageUrl: COVER_URL } }));

    expect(calls).toHaveLength(2);
    expect(calls[1].searchParams.get("cover_url")).toBeNull();
    expect(result).toEqual({ externalPostId: "media-1", note: INSTAGRAM_COVER_REFUSED_NOTE });
  });

  it("a Story never gets a cover", async () => {
    const calls = stubGraph(containerOk);
    await publishAcrossSteps(
      ctx({ cover: { timeMs: 100, imageUrl: COVER_URL }, instagramMetadata: { placement: "story" } }),
    );
    expect(calls[0].searchParams.get("media_type")).toBe("STORIES");
    expect(calls[0].searchParams.get("thumb_offset")).toBeNull();
    expect(calls[0].searchParams.get("cover_url")).toBeNull();
  });
});
