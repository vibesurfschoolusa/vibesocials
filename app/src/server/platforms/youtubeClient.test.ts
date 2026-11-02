import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextPacificMidnight, PACIFIC_RESET_GRACE_MS } from "./rateLimited";
import type { PublishContext } from "./types";
import { computeYouTubeTitle, youtubeClient } from "./youtubeClient";

// 2026-11-01 audit (Task 4 item 1): the YouTube title is the POST's own base
// caption (no footer) — the job's snapshot first, the shared MediaItem's only
// as a legacy fallback — so a reused video gets the title typed for THIS post.
describe("computeYouTubeTitle", () => {
  const media = (baseCaption: string) => ({ baseCaption }) as unknown as MediaItem;

  it("uses the post's own base caption over the shared media item's", () => {
    expect(
      computeYouTubeTitle({
        baseCaption: "Typed for this post",
        mediaItem: media("Caption from the original upload"),
        caption: "Typed for this post\n\n#footer",
      }),
    ).toBe("Typed for this post");
  });

  it("falls back to the media item's caption when the post carries none (legacy jobs)", () => {
    expect(
      computeYouTubeTitle({
        baseCaption: undefined,
        mediaItem: media("Original caption"),
        caption: "Original caption\n\n#footer",
      }),
    ).toBe("Original caption");
  });

  it("falls back to the full caption when both base captions are empty", () => {
    expect(
      computeYouTubeTitle({ baseCaption: "", mediaItem: media(""), caption: "#footer only" }),
    ).toBe("#footer only");
  });

  it("truncates to YouTube's 100-grapheme title limit", () => {
    const title = computeYouTubeTitle({
      baseCaption: "a".repeat(150),
      mediaItem: media(""),
      caption: "",
    });
    expect([...title]).toHaveLength(100);
  });
});

// 2026-11-01 scale audit (platform limits, V9/V10): a YouTube quota response is
// classified into RATE_LIMITED (kind youtube_quota) that carries the next
// Pacific-midnight reset, instead of the generic YOUTUBE_UPLOAD_FAILED.
describe("youtubeClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  function ctx(): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-yt",
        platform: "youtube",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: null,
      } as unknown as SocialConnection,
      mediaItem: {
        mimeType: "video/mp4",
        storageLocation: "https://blob.example.com/v.mp4",
        sizeBytes: 4,
        originalFilename: "v.mp4",
        baseCaption: "title",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
    };
  }

  function stubYouTube(insert: () => Response) {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes("blob.example.com")) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
      }
      if (url.includes("googleapis.com/upload/youtube/v3/videos")) return Promise.resolve(insert());
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const googleError = (status: number, reason: string, headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({ error: { code: status, message: "m", errors: [{ domain: "youtube.quota", reason }] } }),
      { status, headers: { "Content-Type": "application/json", ...headers } },
    );

  async function failure() {
    return youtubeClient.publishVideo(ctx()).then(
      () => null,
      (e: unknown) => e as Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string },
    );
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("insert 403 quotaExceeded -> RATE_LIMITED youtube_quota until the next Pacific midnight plus grace", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    stubYouTube(() => googleError(403, "quotaExceeded"));

    const error = await failure();

    expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "youtube", kind: "youtube_quota" });
    expect(error?.retryAt).toBe(nextPacificMidnight(new Date("2026-11-01T12:00:00Z")).getTime() + PACIFIC_RESET_GRACE_MS);
    expect(error?.retryAt).toBe(Date.UTC(2026, 10, 2, 8, 5, 0));
  });

  it("insert 400 uploadLimitExceeded -> daily_limit", async () => {
    stubYouTube(() => googleError(400, "uploadLimitExceeded"));
    expect(await failure()).toMatchObject({ code: "RATE_LIMITED", kind: "daily_limit" });
  });

  it("insert 403 userRateLimitExceeded -> rate_limited with Retry-After", async () => {
    stubYouTube(() => googleError(403, "userRateLimitExceeded", { "Retry-After": "90" }));
    const error = await failure();
    expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "rate_limited" });
    expect(error?.retryAt).toBeGreaterThan(Date.now());
  });

  it("any other failure keeps YOUTUBE_UPLOAD_FAILED", async () => {
    stubYouTube(() => googleError(403, "forbidden"));
    expect((await failure())?.code).toBe("YOUTUBE_UPLOAD_FAILED");
  });
});
