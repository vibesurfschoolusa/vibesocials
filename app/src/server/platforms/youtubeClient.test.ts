import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE } from "./publishBudget";
import { nextPacificMidnight, PACIFIC_RESET_GRACE_MS } from "./rateLimited";
import { withTransientRetries } from "./transientRetry";
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

function ytCtx(overrides: Partial<PublishContext> = {}): PublishContext {
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
    ...overrides,
  };
}

const INSERT_URL_FRAGMENT = "googleapis.com/upload/youtube/v3/videos";

function stubYouTube(insert: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.includes("blob.example.com")) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
    }
    if (url.includes(INSERT_URL_FRAGMENT)) return Promise.resolve(insert());
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const insertCalls = (fetchMock: ReturnType<typeof stubYouTube>) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(INSERT_URL_FRAGMENT));

// 2026-11-01 scale audit (platform limits, V9/V10): a YouTube quota response is
// classified into RATE_LIMITED (kind youtube_quota) that carries the next
// Pacific-midnight reset, instead of the generic YOUTUBE_UPLOAD_FAILED.
describe("youtubeClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  const ctx = ytCtx;

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

// 2026-11-01 scale audit (jobs H6, Review Focus 5): `videos.insert` is the commit
// call. An ambiguous outcome is PUBLISH_UNCONFIRMED and never re-run; a budget
// refusal before sending stays an ordinary retryable failure.
describe("youtubeClient.publishVideo — commit call (videos.insert)", () => {
  type CodedError = Error & { code?: string };
  const failure = (ctx: PublishContext = ytCtx()) =>
    youtubeClient.publishVideo(ctx).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("insert 502 -> PUBLISH_UNCONFIRMED, and the insert is fetched once", async () => {
    const fetchMock = stubYouTube(() => new Response("bad gateway", { status: 502 }));

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(insertCalls(fetchMock)).toHaveLength(1);
  });

  it("insert 502 is not re-run by the in-step retry", async () => {
    const fetchMock = stubYouTube(() => new Response("bad gateway", { status: 502 }));

    await expect(
      withTransientRetries(() => youtubeClient.publishVideo(ytCtx()), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
    expect(insertCalls(fetchMock)).toHaveLength(1);
  });

  it("a connection reset after the request was sent -> PUBLISH_UNCONFIRMED", async () => {
    stubYouTube(() => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })));

    expect((await failure())?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("a connection that was never made is rethrown unchanged (provably not sent, retryable)", async () => {
    const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    stubYouTube(() => Promise.reject(neverConnected));

    expect(await failure()).toBe(neverConnected);
  });

  it("an insert 4xx keeps YOUTUBE_UPLOAD_FAILED with its status", async () => {
    stubYouTube(() => new Response("{}", { status: 400 }));

    const error = await failure();

    expect(error?.code).toBe("YOUTUBE_UPLOAD_FAILED");
    expect(error).toMatchObject({ status: 400 });
  });

  it("an insert 429 is still classified RATE_LIMITED (commitRequest returns it)", async () => {
    stubYouTube(() => new Response("", { status: 429 }));

    expect((await failure())?.code).toBe("RATE_LIMITED");
  });

  it("a deadline 4 s away -> PUBLISH_TIME_BUDGET_EXCEEDED and no insert request", async () => {
    const fetchMock = stubYouTube(() => new Response("{}", { status: 200 }));
    const deadline = Date.now() + 4_000;
    expect(4_000).toBeLessThan(MIN_REQUEST_WINDOW_MS);

    const error = await failure(ytCtx({ deadline }));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(insertCalls(fetchMock)).toHaveLength(0);
  });

  it("a budget refusal stays an ordinary retryable failure, never PUBLISH_UNCONFIRMED", async () => {
    stubYouTube(() => new Response("{}", { status: 200 }));

    const error = await failure(ytCtx({ deadline: Date.now() + 1_000 }));

    expect(error?.code).not.toBe("PUBLISH_UNCONFIRMED");
    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
  });

  it("clamps the insert timeout to the time left in the step budget", async () => {
    const fetchMock = stubYouTube(
      () => new Response(JSON.stringify({ id: "vid-1", snippet: { title: "t" } }), { status: 200 }),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(youtubeClient.publishVideo(ytCtx({ deadline: Date.now() + 30_000 }))).resolves.toEqual({
      externalPostId: "vid-1",
    });

    expect(insertCalls(fetchMock)).toHaveLength(1);
    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1]);
    // The insert's timer is the one clamped to the ~30 s left (not its 120 s default).
    expect(timeouts.some((ms) => typeof ms === "number" && ms <= 30_000 && ms > MIN_REQUEST_WINDOW_MS)).toBe(true);
  });
});
