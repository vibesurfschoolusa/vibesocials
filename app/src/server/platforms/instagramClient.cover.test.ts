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

// Fix round 1: a container Instagram accepted with the cover but could not
// process (status ERROR) is made once more without it. Nothing is live before
// media_publish, so the Reel still goes, with the note.
describe("instagramClient - a Reel whose cover makes processing fail", () => {
  type Status = "FINISHED" | "ERROR";
  const containersMade: URL[] = [];
  const published: string[] = [];

  function stubWithStatuses(statusOf: Record<string, Status>) {
    containersMade.length = 0;
    published.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/media_publish")) {
          published.push(url.searchParams.get("creation_id") ?? "");
          return Promise.resolve(new Response(JSON.stringify({ id: "media-1" }), { status: 200 }));
        }
        if (url.pathname.endsWith("/ig-account-1/media")) {
          containersMade.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ id: `container-${containersMade.length}` }), { status: 200 }),
          );
        }
        if (url.searchParams.get("fields") === "status_code") {
          const id = url.pathname.split("/").pop() ?? "";
          return Promise.resolve(
            new Response(JSON.stringify({ status_code: statusOf[id] ?? "FINISHED" }), { status: 200 }),
          );
        }
        if (url.searchParams.get("fields") === "permalink") return Promise.resolve(new Response("{}"));
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
  }

  /** Every step of one run, sharing one store, until the client stops asking to continue. */
  async function runSteps(context: PublishContext, store: UploadStateStore = makeStore()) {
    for (let step = 0; step < 6; step++) {
      const result = await instagramClient.publishVideo({ ...context, uploadState: store, mediaItems: context.mediaItems });
      if (!result.continuation) return result;
    }
    throw new Error("too many steps");
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cover sent, FINISHED: published with the cover, no note", async () => {
    stubWithStatuses({});
    expect(await runSteps(ctx({ cover: { imageUrl: COVER_URL } }))).toEqual({ externalPostId: "media-1" });
    expect(containersMade).toHaveLength(1);
  });

  it.each([
    ["cover_url", { imageUrl: COVER_URL }],
    ["thumb_offset", { timeMs: 900 }],
  ])("cover sent (%s), ERROR: one new container without the cover, published, with the note", async (_l, cover) => {
    stubWithStatuses({ "container-1": "ERROR" });

    const result = await runSteps(ctx({ cover }));

    expect(result).toEqual({ externalPostId: "media-1", note: INSTAGRAM_COVER_REFUSED_NOTE });
    expect(containersMade).toHaveLength(2);
    expect(containersMade[1].searchParams.get("cover_url")).toBeNull();
    expect(containersMade[1].searchParams.get("thumb_offset")).toBeNull();
    expect(published).toEqual(["container-2"]);
  });

  it("cover sent, ERROR, and the container without it ERROR too: fails like a Reel without a cover, no third container", async () => {
    stubWithStatuses({ "container-1": "ERROR", "container-2": "ERROR" });

    await expect(runSteps(ctx({ cover: { imageUrl: COVER_URL } }))).rejects.toMatchObject({
      code: "INSTAGRAM_VIDEO_PROCESSING_ERROR",
    });
    expect(containersMade).toHaveLength(2);
    expect(published).toEqual([]);
  });

  it("no cover, ERROR: today's failure, no extra container", async () => {
    stubWithStatuses({ "container-1": "ERROR" });

    await expect(runSteps(ctx())).rejects.toMatchObject({ code: "INSTAGRAM_VIDEO_PROCESSING_ERROR" });
    expect(containersMade).toHaveLength(1);
  });

  it("a step after the container without the cover was saved reuses it (no new container)", async () => {
    stubWithStatuses({});
    const store = makeStore();
    await store.save("instagram_container", {
      data: { containerId: "container-7", createdAt: new Date().toISOString(), checks: 0, coverRefused: true },
    });

    const result = await runSteps(ctx({ cover: { imageUrl: COVER_URL } }), store);

    expect(containersMade).toHaveLength(0);
    expect(published).toEqual(["container-7"]);
    expect(result).toEqual({ externalPostId: "media-1", note: INSTAGRAM_COVER_REFUSED_NOTE });
  });

  it("a user Retry (a new run, so no saved state) tries the cover once more, then falls back the same way", async () => {
    stubWithStatuses({ "container-1": "ERROR" });

    const result = await runSteps(ctx({ cover: { imageUrl: COVER_URL } }), makeStore());

    expect(containersMade[0].searchParams.get("cover_url")).toBe(COVER_URL);
    expect(result).toEqual({ externalPostId: "media-1", note: INSTAGRAM_COVER_REFUSED_NOTE });
  });
});
