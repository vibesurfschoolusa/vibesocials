import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishContext } from "./types";
import {
  YOUTUBE_COVER_FAILED_NOTE,
  YOUTUBE_COVER_FRAME_ONLY_NOTE,
  YOUTUBE_COVER_UNVERIFIED_NOTE,
  youtubeClient,
} from "./youtubeClient";

vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { update: vi.fn() } } }));

const COVER_URL = "https://blob.example.com/cover.jpg";
const INSERT = "googleapis.com/upload/youtube/v3/videos";
const THUMBNAILS = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: {
      id: "conn-yt",
      platform: "youtube",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: null,
    } as unknown as SocialConnection,
    get mediaItems() {
      return [this.mediaItem];
    },
    mediaItem: {
      mimeType: "video/mp4",
      storageLocation: "https://blob.example.com/v.mp4",
      sizeBytes: 4,
      originalFilename: "v.mp4",
      baseCaption: "title",
      metadata: null,
    } as unknown as MediaItem,
    caption: "hello",
    ...overrides,
  };
}

function stub(thumbnails: () => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url === COVER_URL) return Promise.resolve(new Response(new Uint8Array([9, 9, 9])));
    if (url.includes("blob.example.com")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
    if (url.startsWith(THUMBNAILS)) return Promise.resolve(thumbnails());
    if (url.includes(INSERT)) {
      return Promise.resolve(new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const thumbnailCalls = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(THUMBNAILS));

describe("youtubeClient - the video's cover (thumbnails.set)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no cover: no thumbnails.set call, and the result is today's", async () => {
    const fetchMock = stub();
    expect(await youtubeClient.publishVideo(ctx())).toEqual({ externalPostId: "vid-1" });
    expect(thumbnailCalls(fetchMock)).toHaveLength(0);
  });

  it("an image cover: thumbnails.set for the new video, with the image as the body", async () => {
    const fetchMock = stub();

    const result = await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }));

    expect(result).toEqual({ externalPostId: "vid-1" });
    const calls = thumbnailCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe(`${THUMBNAILS}?videoId=vid-1`);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token", "Content-Type": "image/jpeg" });
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from([9, 9, 9]));
  });

  it("a frame with its captured image uses the image", async () => {
    const fetchMock = stub();
    await youtubeClient.publishVideo(ctx({ cover: { timeMs: 1200, imageUrl: COVER_URL } }));
    expect(thumbnailCalls(fetchMock)).toHaveLength(1);
  });

  it("a frame without an image: no call, the post succeeds with a note", async () => {
    const fetchMock = stub();
    const result = await youtubeClient.publishVideo(ctx({ cover: { timeMs: 1200 } }));
    expect(result).toEqual({ externalPostId: "vid-1", note: YOUTUBE_COVER_FRAME_ONLY_NOTE });
    expect(thumbnailCalls(fetchMock)).toHaveLength(0);
  });

  it("YouTube refuses (403, channel not verified): the post still succeeds and records the note", async () => {
    stub(() => new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "forbidden" }] } }), { status: 403 }));

    const result = await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }));

    expect(result).toEqual({ externalPostId: "vid-1", note: YOUTUBE_COVER_UNVERIFIED_NOTE });
    expect(YOUTUBE_COVER_UNVERIFIED_NOTE).toBe(
      "Cover not set: YouTube only allows custom covers on verified channels.",
    );
  });

  const googleError = (status: number, reason: string) =>
    new Response(JSON.stringify({ error: { code: status, errors: [{ domain: "youtube.thumbnail", reason }] } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it.each([
    ["403 quotaExceeded", () => googleError(403, "quotaExceeded")],
    ["403 without a reason", () => new Response("nope", { status: 403 })],
    ["400 invalidImage", () => googleError(400, "invalidImage")],
    ["429 uploadRateLimitExceeded", () => googleError(429, "uploadRateLimitExceeded")],
    ["503", () => new Response("down", { status: 503 })],
  ])("%s is not the verified-channel case: the plain cover note", async (_label, reply) => {
    stub(reply);
    expect(await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }))).toEqual({
      externalPostId: "vid-1",
      note: YOUTUBE_COVER_FAILED_NOTE,
    });
  });

  it("any other refusal or a dropped connection: the post still succeeds, with a plain note", async () => {
    stub(() => new Response("boom", { status: 500 }));
    expect(await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }))).toEqual({
      externalPostId: "vid-1",
      note: YOUTUBE_COVER_FAILED_NOTE,
    });

    stub(() => Promise.reject(new TypeError("fetch failed")));
    expect(await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }))).toEqual({
      externalPostId: "vid-1",
      note: YOUTUBE_COVER_FAILED_NOTE,
    });
  });

  it("thumbnails.set is sent once, never twice (no retry of the cover)", async () => {
    const fetchMock = stub(() => new Response("boom", { status: 503 }));
    await youtubeClient.publishVideo(ctx({ cover: { imageUrl: COVER_URL } }));
    expect(thumbnailCalls(fetchMock)).toHaveLength(1);
  });
});
