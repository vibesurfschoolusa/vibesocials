import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FACEBOOK_COVER_FRAME_ONLY_NOTE,
  FACEBOOK_COVER_REFUSED_NOTE,
  facebookPageClient,
} from "@/server/platforms/facebookPageClient";
import type { PublishContext } from "@/server/platforms/types";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: vi.fn(), findUnique: vi.fn() } },
}));

vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fetchWithTimeout")>()),
  fetchWithTimeout: fetchMock,
}));

const COVER_URL = "https://blob.example.com/cover.jpg";

function ctx(extra: Partial<PublishContext> = {}): PublishContext {
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: {
      id: "conn-1",
      platform: "facebook_page",
      accessToken: "page-access-token",
      accountIdentifier: "page-1",
      metadata: null,
    } as unknown as SocialConnection,
    get mediaItems() {
      return [this.mediaItem];
    },
    mediaItem: {
      mimeType: "video/mp4",
      storageLocation: "https://blob.example.com/v.mp4",
      metadata: null,
    } as unknown as MediaItem,
    caption: "hello",
    ...extra,
  };
}

type VideosRoute = (body: unknown) => Response;
function stub(videos: VideosRoute = () => new Response(JSON.stringify({ id: "video-1" }), { status: 200 })) {
  const bodies: unknown[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === COVER_URL) return Promise.resolve(new Response(new Uint8Array([7, 7])));
    if (url.endsWith("/page-1/videos")) {
      bodies.push(init?.body);
      return Promise.resolve(videos(init?.body));
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return bodies;
}

describe("facebookPageClient - a video's cover (thumb)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no cover: today's form body, no thumb", async () => {
    const bodies = stub();
    expect(await facebookPageClient.publishVideo(ctx())).toEqual({ externalPostId: "video-1" });
    expect(bodies[0]).toBeInstanceOf(URLSearchParams);
    expect((bodies[0] as URLSearchParams).get("thumb")).toBeNull();
  });

  it("an image cover: the same fields as multipart, with the image as `thumb`", async () => {
    const bodies = stub();

    const result = await facebookPageClient.publishVideo(ctx({ cover: { timeMs: 900, imageUrl: COVER_URL } }));

    expect(result).toEqual({ externalPostId: "video-1" });
    const body = bodies[0] as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("file_url")).toBe("https://blob.example.com/v.mp4");
    expect(body.get("description")).toBe("hello");
    expect(body.get("access_token")).toBe("page-access-token");
    const thumb = body.get("thumb") as Blob;
    expect(thumb.type).toBe("image/jpeg");
    expect(Buffer.from(await thumb.arrayBuffer())).toEqual(Buffer.from([7, 7]));
  });

  it("refused with the thumb (4xx: nothing published): sent once more without it, with a note", async () => {
    const bodies = stub((body) =>
      body instanceof FormData
        ? new Response(JSON.stringify({ error: { message: "bad thumb", code: 100 } }), { status: 400 })
        : new Response(JSON.stringify({ id: "video-1" }), { status: 200 }),
    );

    const result = await facebookPageClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }));

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBeInstanceOf(URLSearchParams);
    expect(result).toEqual({ externalPostId: "video-1", note: FACEBOOK_COVER_REFUSED_NOTE });
  });

  it("a 5xx with the thumb is never re-sent (the video may be live)", async () => {
    const bodies = stub(() => new Response("bad gateway", { status: 502 }));
    await expect(facebookPageClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }))).rejects.toMatchObject({
      code: "PUBLISH_UNCONFIRMED",
    });
    expect(bodies).toHaveLength(1);
  });

  it("a frame without an image: no thumb, a note", async () => {
    const bodies = stub();
    const result = await facebookPageClient.publishVideo(ctx({ cover: { timeMs: 900 } }));
    expect(bodies[0]).toBeInstanceOf(URLSearchParams);
    expect(result).toEqual({ externalPostId: "video-1", note: FACEBOOK_COVER_FRAME_ONLY_NOTE });
  });

  it("a Story never gets a cover", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("video_stories")) {
        return Promise.resolve(new Response("{}", { status: 400 }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    await facebookPageClient
      .publishVideo(ctx({ cover: { imageUrl: COVER_URL }, facebookMetadata: { placement: "story" } }))
      .catch(() => null);
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(COVER_URL);
  });
});
