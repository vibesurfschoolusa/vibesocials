import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { YOUTUBE_UPLOAD_STATE_KIND, type UploadStateStore } from "@/server/jobs/uploadState";

import { LARGE_UPLOAD_CHUNK_WINDOW_MS, LARGE_VIDEO_THRESHOLD_BYTES } from "./largeUpload";
import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
import { nextPacificMidnight, PACIFIC_RESET_GRACE_MS } from "./rateLimited";
import { withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import {
  buildYouTubeVideoResource,
  computeYouTubeTitle,
  YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS,
  YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP,
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
  YOUTUBE_STATUS_TIMEOUT_MS,
  YOUTUBE_TRANSIENT_RESUME_DELAY_MS,
  youtubeClient,
} from "./youtubeClient";

// refreshGoogleToken persists through `await import("@/lib/db")` at call time,
// so it receives this mock. No real database is touched.
const { updateMock, refreshConnectionTokenMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  // The per-connection refresh lock has its own suite (connectionRefresh.test.ts):
  // here it is a pass-through spy, so the refresh itself still runs.
  refreshConnectionTokenMock: vi.fn<
    (
      snapshot: unknown,
      refresh: (current: unknown) => Promise<unknown>,
      opts?: { deadline?: number },
    ) => Promise<unknown>
  >((snapshot, refresh) => refresh(snapshot)),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

vi.mock("./connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
}));

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

/** A 2xx body that errors while it is being read (the connection drops mid-body). */
const erroringBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });

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

  // Final review F4 (I2): a 2xx insert means the video may exist, so a success
  // body that cannot be read or parsed is PUBLISH_UNCONFIRMED, never a plain
  // failure that invites a retry (a second upload).
  it.each([
    ["invalid JSON", () => new Response("<html>ok</html>", { status: 200 })],
    ["a body that errors mid-read", () => new Response(erroringBody(), { status: 200 })],
  ] as const)("a 2xx insert with %s -> PUBLISH_UNCONFIRMED, insert fetched once", async (_name, make) => {
    const fetchMock = stubYouTube(make);

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(insertCalls(fetchMock)).toHaveLength(1);
  });

  // 2026-11-02 scale audit (jobs): the insert answered 2xx ("created") but
  // the parsed body has no video id. The old plain YOUTUBE_NO_VIDEO_ID failure
  // invited a retry (a second upload): it is PUBLISH_UNCONFIRMED now.
  it.each([
    ["{}", "{}"],
    ["an empty id", JSON.stringify({ id: "" })],
    ["a numeric id", JSON.stringify({ id: 9 })],
    ["a JSON null body", "null"],
  ])("a 2xx insert with %s -> PUBLISH_UNCONFIRMED (not YOUTUBE_NO_VIDEO_ID), insert fetched once", async (_name, body) => {
    const fetchMock = stubYouTube(() => new Response(body, { status: 200 }));

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.code).not.toBe("YOUTUBE_NO_VIDEO_ID");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(insertCalls(fetchMock)).toHaveLength(1);
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

// 2026-11-01 scale audit (step budget, Task 7): every YouTube request - the token
// refresh, the media download and videos.insert - ends by the step deadline, and
// none is started with under 5 s left. Vercel kills the invocation at 300 s;
// the step must end well inside it (publishBudget.ts).
describe("youtubeClient.publishVideo — step deadline", () => {
  type CodedError = Error & { code?: string };
  const failure = (ctx: PublishContext) =>
    youtubeClient.publishVideo(ctx).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  const NOW = Date.parse("2026-11-01T12:00:00Z");
  const TOKEN_URL_FRAGMENT = "oauth2.googleapis.com/token";
  const expiredCtx = (overrides: Partial<PublishContext> = {}) => {
    const base = ytCtx(overrides);
    return {
      ...base,
      socialConnection: { ...base.socialConnection, expiresAt: new Date("2020-01-01T00:00:00Z") },
    } as PublishContext;
  };
  const tokenOk = () =>
    new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600, token_type: "Bearer" }), {
      status: 200,
    });
  const insertOk = () => new Response(JSON.stringify({ id: "vid-1", snippet: { title: "t" } }), { status: 200 });
  const blobOk = () => new Response(new Uint8Array([1, 2, 3, 4]));

  /** Resolve after `ms` of (fake) time - or reject if the request is aborted first. */
  const slow = (ms: number, make: () => Response) => (init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  /** Never answers: settles only when the request is aborted. */
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  function stubRoutes(routes: Record<string, (init?: RequestInit) => Promise<Response>>) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const route = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      if (!route) throw new Error(`Unexpected fetch in test: ${url}`);
      return route[1](init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "conn-yt", platform: "youtube", refreshToken: "refresh-token", ...args.data }),
    );
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to start once the step budget is spent (no request at all)", async () => {
    const fetchMock = stubYouTube(() => new Response("{}", { status: 200 }));

    const error = await failure(ytCtx({ deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1 }));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to refresh an expired token with under 5 s left (no token request)", async () => {
    const fetchMock = stubYouTube(() => new Response("{}", { status: 200 }));

    const error = await failure(expiredCtx({ deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1 }));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("clamps the token refresh, the download and the insert to the time left (each <= 12 s)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const fetchMock = stubRoutes({
      [TOKEN_URL_FRAGMENT]: async () => tokenOk(),
      "blob.example.com": async () => blobOk(),
      [INSERT_URL_FRAGMENT]: async () => insertOk(),
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await expect(youtubeClient.publishVideo(expiredCtx({ deadline: NOW + 12_000 }))).resolves.toEqual({
      externalPostId: "vid-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    // refresh (30 s default), download (120 s default), insert (120 s default)
    expect(timeouts).toHaveLength(3);
    for (const timeout of timeouts) {
      expect(timeout).toBeLessThanOrEqual(12_000);
      expect(timeout).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
    }
    // The download's whole-transfer bound (the body is read after the headers).
    expect(abortTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(abortTimeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(12_000);
  });

  it("worst case: slow refresh + download and a hung insert still settle by the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    const fetchMock = stubRoutes({
      [TOKEN_URL_FRAGMENT]: slow(25_000, tokenOk),
      "blob.example.com": slow(119_000, blobOk),
      [INSERT_URL_FRAGMENT]: hang,
    });

    let settledAt = 0;
    const promise = failure(expiredCtx({ deadline })).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(400_000);
    const error = await promise;

    // Refresh + download took 144 s; the insert hung and was cut off at the
    // deadline (unclamped it would run to 144 + 120 = 264 s).
    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes(INSERT_URL_FRAGMENT))).toHaveLength(1);
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });

  it("a download started late (an in-step retry) is cut off at the deadline, not at its own 120 s", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // withTransientRetries only retries with >= 60 s left: ~61 s remain here.
    const deadline = start + 61_000;
    const fetchMock = stubRoutes({
      "blob.example.com": hang,
      [INSERT_URL_FRAGMENT]: async () => insertOk(),
    });

    let settledAt = 0;
    const promise = failure(ytCtx({ deadline })).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(400_000);
    const error = await promise;

    expect(error?.code).toBe("FETCH_TIMEOUT");
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes(INSERT_URL_FRAGMENT))).toHaveLength(0);
  });
});

// 2026-11-01 scale audit (jobs, token refresh): every YouTube refresh goes
// through refreshConnectionToken (connectionRefresh.ts), which serializes it per
// connection and hands back the stored row when another process refreshed first.
describe("youtubeClient — serialized token refresh", () => {
  const expired = () => {
    const base = ytCtx();
    return {
      ...base,
      socialConnection: { ...base.socialConnection, expiresAt: new Date("2020-01-01T00:00:00Z") },
    } as PublishContext;
  };

  beforeEach(() => {
    refreshConnectionTokenMock.mockClear();
    updateMock.mockReset();
    updateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "conn-yt", platform: "youtube", refreshToken: "refresh-token", ...args.data }),
    );
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("publishVideo routes an expired token's refresh through refreshConnectionToken with the snapshot and the step deadline", async () => {
    stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));
    // Another process refreshed first: the lock hands back its row, no token request is made.
    refreshConnectionTokenMock.mockResolvedValueOnce({
      id: "conn-yt",
      platform: "youtube",
      accessToken: "winner-access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const deadline = Date.now() + 60_000;
    const ctx = expired();

    await youtubeClient.publishVideo({ ...ctx, deadline });

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0]).toBe(ctx.socialConnection);
    expect(refreshConnectionTokenMock.mock.calls[0][2]).toEqual({ deadline });
    expect(updateMock).not.toHaveBeenCalled();
    const insertCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes(INSERT_URL_FRAGMENT),
    );
    const headers = (insertCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer winner-access-token");
  });

  it("publishVideo does not take the lock for a token that is still fresh", async () => {
    stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

    await youtubeClient.publishVideo(ytCtx());

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("refreshToken (the health sweep's hook) forwards its deadline to the Google refresh", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "swept", expires_in: 3600, token_type: "Bearer" }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await youtubeClient.refreshToken!(ytCtx().socialConnection, { deadline: Date.now() + 8_000 });

    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
  });
});

// 2026-11-02 scale audit (jobs B3): a video above 50 MiB on an enabled platform
// uploads through YouTube's resumable protocol, 16 MiB at a time, across steps.
// Every request is faked; the video is a lazily generated stream (never 90 MiB at
// once), and the upload state is an in-memory store with the real store's rules.
describe("youtubeClient.publishVideo — resumable upload (jobs B3)", () => {
  const MIB = 1024 * 1024;
  const CHUNK = YOUTUBE_RESUMABLE_CHUNK_BYTES;
  /** 90 MiB: five 16 MiB chunks, then a 10 MiB last one. */
  const TOTAL = LARGE_VIDEO_THRESHOLD_BYTES + 40 * MIB;
  const LAST_START = 5 * CHUNK;
  const SESSION_URI =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-SECRET-1";
  const START_FRAGMENT = "uploadType=resumable&part=";
  const SESSION_FRAGMENT = "upload_id=SESSION-SECRET-1";
  const NOW = Date.parse("2026-11-02T10:00:00.000Z");
  const STEP = PUBLISH_STEP_BUDGET_MS;

  type Req = { url: string; init: RequestInit };
  type Reply = (req: Req) => Response | Promise<Response>;
  type CodedError = Error & { code?: string; status?: number; kind?: string };

  /** The byte the fake blob holds at absolute position `p`. */
  const byteAt = (p: number) => p % 251;

  /** Bytes `start..total-1` of the video, produced only when the reader asks (no read-ahead). */
  function lazyBlobBody(start: number, total: number) {
    let produced = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const size = Math.min(1_000_000, total - start - produced);
          if (size <= 0) {
            controller.close();
            return;
          }
          const out = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) out[i] = byteAt(start + produced + i);
          controller.enqueue(out);
          produced += size;
        },
      },
      { highWaterMark: 0 },
    );
  }

  const reply =
    (status: number, body: string | null = null, headers: Record<string, string> = {}): Reply =>
    () =>
      new Response(body, { status, headers });
  const createdBody = (id: string) => JSON.stringify({ id, snippet: { title: "t" } });
  const created = (id = "v1"): Reply => reply(201, createdBody(id));
  const incomplete = (lastByte?: number): Reply =>
    reply(308, null, lastByte === undefined ? {} : { Range: `bytes=0-${lastByte}` });
  const googleError = (status: number, reason: string): Reply =>
    reply(status, JSON.stringify({ error: { code: status, message: "m", errors: [{ domain: "youtube.quota", reason }] } }), {
      "Content-Type": "application/json",
    });
  const failWith =
    (error: unknown): Reply =>
    () =>
      Promise.reject(error);
  const timeout = () => failWith(Object.assign(new Error("Request timed out after 120000ms"), { code: "FETCH_TIMEOUT" }));
  const connectionReset = () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
  const startOk =
    (uri = SESSION_URI): Reply =>
    () =>
      new Response(null, { status: 200, headers: { Location: uri } });

  const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
  const contentRange = (init?: RequestInit) => headersOf(init)["Content-Range"];

  /** Accepts a chunk the way YouTube does: 308 with the new Range, or 201 for the last one. */
  const acceptChunk: Reply = ({ init }) => {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange(init) ?? "");
    if (!match) throw new Error(`Not a chunk request: ${contentRange(init)}`);
    return Number(match[2]) + 1 >= Number(match[3])
      ? new Response(createdBody("v1"), { status: 201 })
      : new Response(null, { status: 308, headers: { Range: `bytes=0-${match[2]}` } });
  };
  const accepts = (count: number): Reply[] => Array.from({ length: count }, () => acceptChunk);

  /** The clock moves while a request is in flight. */
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const after =
    (ms: number, next: Reply): Reply =>
    (req) => {
      advance(ms);
      return next(req);
    };

  /**
   * Fakes the blob, the session start and the session URI. `session` is the script of
   * answers to PUTs on the session URI, in order (status queries and chunks alike).
   */
  function stubUpload(
    opts: {
      total?: number;
      start?: Reply[];
      session?: Reply[];
      blobStatus?: number;
      blobAdvance?: number;
      /** The blob's body hands out a little, then fails with this (the connection dropped mid-body). */
      blobBodyFailure?: unknown;
    } = {},
  ) {
    const total = opts.total ?? TOTAL;
    const starts = [...(opts.start ?? [startOk()])];
    const session = [...(opts.session ?? [])];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("blob.example.com")) {
        const range = /^bytes=(\d+)-$/.exec(headersOf(init)["Range"] ?? "");
        const start = range ? Number(range[1]) : 0;
        if (opts.blobStatus !== undefined) return new Response(null, { status: opts.blobStatus });
        if (opts.blobAdvance !== undefined) advance(opts.blobAdvance); // a slow blob read
        if (opts.blobBodyFailure !== undefined) {
          const bodyError = opts.blobBodyFailure;
          let sent = false;
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (sent) return controller.error(bodyError);
                sent = true;
                controller.enqueue(new Uint8Array(1_000));
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, {
            status: 206,
            headers: { "Content-Range": `bytes ${start}-${total - 1}/${total}` },
          });
        }
        return range
          ? new Response(lazyBlobBody(start, total), {
              status: 206,
              headers: { "Content-Range": `bytes ${start}-${total - 1}/${total}` },
            })
          : new Response(lazyBlobBody(0, total), { status: 200, headers: { "Content-Length": String(total) } });
      }
      const next = url.includes(START_FRAGMENT)
        ? starts.shift()
        : url.includes(SESSION_FRAGMENT)
          ? session.shift()
          : undefined;
      if (!next) throw new Error(`Unexpected fetch in test: ${init?.method ?? "GET"} ${url}`);
      return next({ url, init: init ?? {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const callsTo = (fragment: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));
    const sessionCalls = () => callsTo(SESSION_FRAGMENT);
    return {
      fetchMock,
      blobGets: () => callsTo("blob.example.com"),
      starts: () => callsTo(START_FRAGMENT),
      /** PUTs with a body: the chunks. */
      puts: () => sessionCalls().filter((c) => (c[1] as RequestInit).body != null),
      /** PUTs without a body: the status queries. */
      statusQueries: () => sessionCalls().filter((c) => (c[1] as RequestInit).body == null),
      sessionCalls,
    };
  }

  /** An in-memory store with the real store's rules: a kind, a readable `data` that holds no URL, a secret. */
  function fakeStore(initial?: { data: unknown; secret?: unknown }) {
    let current: { kind: string; data: unknown; secret?: unknown } | null = initial
      ? { kind: YOUTUBE_UPLOAD_STATE_KIND, ...initial }
      : null;
    const mocks = {
      load: vi.fn(async (kind: string) =>
        current && current.kind === kind
          ? {
              data: structuredClone(current.data),
              ...(current.secret !== undefined ? { secret: structuredClone(current.secret) } : {}),
            }
          : null,
      ),
      save: vi.fn(async (kind: string, snapshot: { data: unknown; secret?: unknown }) => {
        if ((JSON.stringify(snapshot.data) ?? "").includes("://")) {
          throw Object.assign(new Error("The upload could not be tracked."), { code: "UPLOAD_STATE_PLAINTEXT_URL" });
        }
        current = { kind, ...structuredClone(snapshot) };
      }),
      clear: vi.fn(async () => {
        current = null;
      }),
    };
    return { store: mocks as unknown as UploadStateStore, mocks, saved: () => current };
  }

  /** A saved session that holds `confirmedBytes` bytes. */
  const sessionAt = (confirmedBytes: number, total = TOTAL) => ({
    data: { totalBytes: total, confirmedBytes },
    secret: { sessionUri: SESSION_URI },
  });

  function bigCtx(
    store: UploadStateStore | undefined,
    overrides: Partial<PublishContext> = {},
    sizeBytes = TOTAL,
  ): PublishContext {
    const base = ytCtx({ uploadState: store, ...overrides });
    return { ...base, mediaItem: { ...base.mediaItem, sizeBytes } as MediaItem };
  }

  const run = (ctx: PublishContext) => youtubeClient.publishVideo(ctx);
  const failure = (ctx: PublishContext) =>
    run(ctx).then(
      () => null,
      (e: unknown) => e as CodedError,
    );
  const TRANSIENT_RESUME_DELAY = 30_000;
  /** A failure that says nothing about the upload: the next step starts `ms` from now. */
  const pausedFor = (ms: number) => ({ continuation: { resumeAt: Date.now() + ms } });

  /** The sampled bytes of a chunk PUT's body are the video's bytes from `first`. */
  function expectBodyFrom(call: Parameters<typeof fetch> | undefined, first: number) {
    const body = (call?.[1] as RequestInit).body as Buffer;
    for (const at of [0, 1, Math.floor(body.length / 2), body.length - 1]) {
      expect(body[at]).toBe(byteAt(first + at));
    }
  }

  /** Every console call of the test (the logger writes through console), as one string. */
  const everythingLogged = () =>
    JSON.stringify(
      (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.mocked(console[level]).mock.calls),
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "youtube");
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    refreshConnectionTokenMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("starting a session (no saved state)", () => {
    it("POSTs ?uploadType=resumable with X-Upload-Content-Length / -Type and the video resource as the body", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: accepts(6) });
      const ctx = bigCtx(store, { caption: "Holiday #travel #sun" });

      await run(ctx);

      const [url, init] = upload.starts()[0] as [string, RequestInit];
      expect(upload.starts()).toHaveLength(1);
      expect(url).toBe("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
      expect(init.method).toBe("POST");
      expect(headersOf(init)).toMatchObject({
        Authorization: "Bearer access-token",
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(TOTAL),
        "X-Upload-Content-Type": "video/mp4",
      });
      expect(JSON.parse(init.body as string)).toEqual(buildYouTubeVideoResource(ctx).metadata);
      expect(JSON.parse(init.body as string).snippet).toMatchObject({
        tags: ["travel", "sun"],
        description: "Holiday #travel #sun",
      });
    });

    it("sends the same resource and `part` as the multipart upload does for the same post", async () => {
      // A location with coordinates makes `part` include recordingDetails, so both are exercised.
      const post = (uploadState: UploadStateStore | undefined, sizeBytes: number) => {
        const base = bigCtx(uploadState, { caption: "Trip #a" }, sizeBytes);
        const metadata = { location: { description: "Lisbon (38.72, -9.14)" } };
        return { ...base, mediaItem: { ...base.mediaItem, metadata } as MediaItem };
      };
      // Multipart: a small video, no store.
      const small = stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));
      await run(post(undefined, 4));
      const [multipartUrl, multipartInit] = insertCalls(small)[0] as [string, RequestInit];
      const multipartText = Buffer.from(multipartInit.body as Buffer).toString("utf8");
      const multipartResource = JSON.parse(
        /charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--/.exec(multipartText)![1],
      ) as Record<string, unknown>;
      vi.unstubAllGlobals();

      // Resumable: a large video with a store.
      const { store } = fakeStore();
      const upload = stubUpload({ session: accepts(6) });
      await run(post(store, TOTAL));
      const [startUrl, startInit] = upload.starts()[0] as [string, RequestInit];

      expect(multipartResource.recordingDetails).toBeDefined();
      expect(JSON.parse(startInit.body as string)).toEqual(multipartResource);
      expect(new URL(startUrl).searchParams.get("part")).toBe("snippet,status,recordingDetails");
      expect(new URL(startUrl).searchParams.get("part")).toBe(new URL(multipartUrl).searchParams.get("part"));
    });

    it("saves the session at once - the URI sealed in `secret`, offsets in `data` - before the first chunk is sent", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubUpload({ session: accepts(6) });

      await run(bigCtx(store));

      expect(mocks.load).toHaveBeenCalledWith("youtube_resumable");
      expect(mocks.save.mock.calls[0]).toEqual([
        "youtube_resumable",
        { data: { totalBytes: TOTAL, confirmedBytes: 0 }, secret: { sessionUri: SESSION_URI } },
      ]);
      expect(YOUTUBE_UPLOAD_STATE_KIND).toBe("youtube_resumable");
      const saveOrder = mocks.save.mock.invocationCallOrder[0];
      const firstPut = upload.fetchMock.mock.calls.indexOf(upload.puts()[0]);
      const start = upload.fetchMock.mock.calls.indexOf(upload.starts()[0]);
      expect(saveOrder).toBeLessThan(upload.fetchMock.mock.invocationCallOrder[firstPut]);
      expect(saveOrder).toBeGreaterThan(upload.fetchMock.mock.invocationCallOrder[start]);
    });

    it("an answer without a Location is YOUTUBE_UPLOAD_FAILED, and nothing is saved or sent", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubUpload({ start: [reply(200)] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("YOUTUBE_UPLOAD_FAILED");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(upload.sessionCalls()).toHaveLength(0);
    });

    it("a Location that is not an https URL is YOUTUBE_UPLOAD_FAILED (the token is never sent over plain http)", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubUpload({ start: [startOk("http://www.googleapis.com/upload?upload_id=x")] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("YOUTUBE_UPLOAD_FAILED");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(upload.sessionCalls()).toHaveLength(0);
    });

    it("a quota answer is classified first: RATE_LIMITED youtube_quota until the next Pacific midnight", async () => {
      const { store, mocks } = fakeStore();
      stubUpload({ start: [googleError(403, "quotaExceeded")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "youtube_quota" });
      expect((error as unknown as { retryAt: number }).retryAt).toBe(
        nextPacificMidnight(new Date(NOW)).getTime() + PACIFIC_RESET_GRACE_MS,
      );
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a 5xx on the start is an ordinary failure (retryable), never PUBLISH_UNCONFIRMED: no video exists yet", async () => {
      const { store } = fakeStore();
      stubUpload({ start: [reply(503, "unavailable")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "YOUTUBE_UPLOAD_FAILED", status: 503 });
    });
  });

  describe("chunks", () => {
    it("uploads 90 MiB as five 16 MiB chunks and a 10 MiB last one, in one step with the whole budget", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: accepts(6) });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual({ externalPostId: "v1" });
      const puts = upload.puts();
      expect(puts).toHaveLength(6);
      expect(puts.map((c) => contentRange(c[1] as RequestInit))).toEqual([
        `bytes 0-${CHUNK - 1}/${TOTAL}`,
        `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`,
        `bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${TOTAL}`,
        `bytes ${3 * CHUNK}-${4 * CHUNK - 1}/${TOTAL}`,
        `bytes ${4 * CHUNK}-${5 * CHUNK - 1}/${TOTAL}`,
        `bytes ${LAST_START}-${TOTAL - 1}/${TOTAL}`,
      ]);
      const lengths = puts.map((c) => ((c[1] as RequestInit).body as Buffer).length);
      expect(lengths).toEqual([CHUNK, CHUNK, CHUNK, CHUNK, CHUNK, TOTAL - LAST_START]);
      // Every chunk but the last is a multiple of 256 KiB, and none is over 16 MiB.
      expect(CHUNK).toBe(16_777_216);
      for (const length of lengths.slice(0, -1)) expect(length % 262_144).toBe(0);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(16 * MIB);
      puts.forEach((call, index) => {
        expect(call[0]).toBe(SESSION_URI);
        expect((call[1] as RequestInit).method).toBe("PUT");
        expect(headersOf(call[1] as RequestInit)).toMatchObject({
          Authorization: "Bearer access-token",
          "Content-Length": String(lengths[index]),
        });
        expectBodyFrom(call, index * CHUNK);
      });
    });

    it("reads the blob with one ranged GET for the whole step, and asks the session nothing on a fresh start", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: accepts(6) });

      await run(bigCtx(store));

      expect(upload.blobGets()).toHaveLength(1);
      expect(headersOf(upload.blobGets()[0][1] as RequestInit)["Range"]).toBe("bytes=0-");
      expect(upload.statusQueries()).toHaveLength(0);
      expect(upload.starts()).toHaveLength(1);
    });

    it("keeps nothing but offsets in the readable state while it uploads: no URL in `data`", async () => {
      const { store, mocks } = fakeStore();
      stubUpload({ session: [acceptChunk, reply(429)] });

      await failure(bigCtx(store));

      expect(mocks.save).toHaveBeenCalledTimes(2);
      for (const [, snapshot] of mocks.save.mock.calls) {
        expect(JSON.stringify((snapshot as { data: unknown }).data)).not.toContain("://");
      }
    });

    it("a partial 308 (Range 1 MiB short of what was sent) resends the remainder from the same buffer", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: [incomplete(CHUNK - MIB - 1), ...accepts(6)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "v1" });
      const puts = upload.puts();
      expect(puts).toHaveLength(7);
      expect(contentRange(puts[0][1] as RequestInit)).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
      expect(contentRange(puts[1][1] as RequestInit)).toBe(`bytes ${CHUNK - MIB}-${CHUNK - 1}/${TOTAL}`);
      expect(((puts[1][1] as RequestInit).body as Buffer).length).toBe(MIB);
      expectBodyFrom(puts[1], CHUNK - MIB);
      // The next chunk continues where the resent one ends - and the blob was read once.
      expect(contentRange(puts[2][1] as RequestInit)).toBe(`bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`);
      expect(upload.blobGets()).toHaveLength(1);
    });

    it("a 308 with no Range header means the session holds nothing: the chunk is resent whole", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: [incomplete(), ...accepts(6)] });

      await run(bigCtx(store));

      const puts = upload.puts();
      expect(contentRange(puts[0][1] as RequestInit)).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
      expect(contentRange(puts[1][1] as RequestInit)).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
      expectBodyFrom(puts[1], 0);
    });

    it("accepts the Range written without the `bytes=` prefix", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: [reply(308, null, { Range: `0-${CHUNK - 1}` }), ...accepts(5)] });

      await run(bigCtx(store));

      expect(contentRange(upload.puts()[1][1] as RequestInit)).toBe(`bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`);
    });

    it("a 308 whose Range cannot be read is YOUTUBE_UPLOAD_FAILED (the chunk was not committed)", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [reply(308, null, { Range: "garbage" })] });

      expect((await failure(bigCtx(store)))?.code).toBe("YOUTUBE_UPLOAD_FAILED");
    });

    it("a chunk that is not the last but is answered 201 means the video exists: it is returned, not continued", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [created("early")] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "early" });
    });

    it("a rejected chunk (400) is YOUTUBE_UPLOAD_FAILED with its status, not PUBLISH_UNCONFIRMED", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [reply(400, "{}")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "YOUTUBE_UPLOAD_FAILED", status: 400 });
    });

    it("a chunk request that never connected is rethrown unchanged (provably unsent)", async () => {
      const { store } = fakeStore();
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubUpload({ session: [failWith(neverConnected)] });

      expect(await failure(bigCtx(store))).toBe(neverConnected);
    });
  });

  describe("across steps", () => {
    it("fits two chunks in the first step, saves and continues; the next step asks the session and resumes without a second start", async () => {
      const { store, mocks, saved } = fakeStore();
      // Each chunk takes 90 s of the 225 s step: the third would start with 45 s left (< 60 s).
      const first = stubUpload({ session: [after(90_000, acceptChunk), after(90_000, acceptChunk)] });

      const stepOne = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(stepOne).toEqual({ continuation: { resumeAt: null } });
      expect(first.puts()).toHaveLength(2);
      const progress = { totalBytes: TOTAL, confirmedBytes: 2 * CHUNK };
      expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual({ data: progress, secret: { sessionUri: SESSION_URI } });
      expect(saved()).toEqual({ kind: "youtube_resumable", data: progress, secret: { sessionUri: SESSION_URI } });
      vi.unstubAllGlobals();

      // The next step: a fresh budget, the same store. Its number does not matter.
      vi.setSystemTime(NOW + 300_000);
      const second = stubUpload({ session: [incomplete(2 * CHUNK - 1), ...accepts(4)] });
      const stepTwo = await run(bigCtx(store, { deadline: Date.now() + STEP, continuation: 1 }));

      expect(stepTwo).toEqual({ externalPostId: "v1" });
      expect(second.starts()).toHaveLength(0);
      // The first request of the step is the status query: an empty PUT.
      const query = second.sessionCalls()[0][1] as RequestInit;
      expect(query.method).toBe("PUT");
      expect(query.body).toBeUndefined();
      expect(headersOf(query)).toMatchObject({
        Authorization: "Bearer access-token",
        "Content-Range": `bytes */${TOTAL}`,
      });
      expect(second.blobGets()).toHaveLength(1);
      expect(headersOf(second.blobGets()[0][1] as RequestInit)["Range"]).toBe(`bytes=${2 * CHUNK}-`);
      const puts = second.puts();
      expect(contentRange(puts[0][1] as RequestInit)).toBe(`bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${TOTAL}`);
      expectBodyFrom(puts[0], 2 * CHUNK);
      expect(contentRange(puts.at(-1)![1] as RequestInit)).toBe(`bytes ${LAST_START}-${TOTAL - 1}/${TOTAL}`);
    });

    it("resumes from what the SESSION holds, not from the saved offset", async () => {
      // The state says 16 MiB, the session says 32 MiB.
      const { store } = fakeStore(sessionAt(CHUNK));
      const upload = stubUpload({ session: [incomplete(2 * CHUNK - 1), ...accepts(4)] });

      await run(bigCtx(store));

      expect(contentRange(upload.puts()[0][1] as RequestInit)).toBe(`bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${TOTAL}`);
    });

    it("a status query with no Range header means nothing was received: the upload restarts at byte 0 of the SAME session", async () => {
      const { store } = fakeStore(sessionAt(3 * CHUNK));
      const upload = stubUpload({ session: [incomplete(), ...accepts(6)] });

      await run(bigCtx(store));

      expect(headersOf(upload.blobGets()[0][1] as RequestInit)["Range"]).toBe("bytes=0-");
      expect(upload.starts()).toHaveLength(0);
      expect(contentRange(upload.puts()[0][1] as RequestInit)).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
    });

    it("decides start or resume from the saved state alone, never from ctx.continuation", async () => {
      // A step number of 3 with nothing saved starts a session...
      const empty = fakeStore();
      const started = stubUpload({ session: accepts(6) });
      await run(bigCtx(empty.store, { continuation: 3 }));
      expect(started.starts()).toHaveLength(1);
      vi.unstubAllGlobals();

      // ...and step 0 with a session saved resumes it (the retry of a step whose output was lost).
      const saved = fakeStore(sessionAt(CHUNK));
      const resumed = stubUpload({ session: [incomplete(CHUNK - 1), ...accepts(5)] });
      await run(bigCtx(saved.store, { continuation: 0 }));
      expect(resumed.starts()).toHaveLength(0);
      expect(resumed.statusQueries()).toHaveLength(1);
    });

    it("finishes without a single chunk when the status query says the upload is already complete", async () => {
      const { store } = fakeStore(sessionAt(5 * CHUNK));
      const upload = stubUpload({ session: [created("done-already")] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "done-already" });
      expect(upload.puts()).toHaveLength(0);
      expect(upload.blobGets()).toHaveLength(0);
    });

    it("a complete status without a video id is PUBLISH_UNCONFIRMED", async () => {
      const { store } = fakeStore(sessionAt(5 * CHUNK));
      stubUpload({ session: [reply(200, "{}")] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a status Range that covers the whole video (yet incomplete) is PUBLISH_UNCONFIRMED: the video may be about to appear", async () => {
      const { store } = fakeStore(sessionAt(5 * CHUNK));
      const upload = stubUpload({ session: [incomplete(TOTAL - 1)] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.puts()).toHaveLength(0);
    });

    it("a failing status query is YOUTUBE_UPLOAD_FAILED with its status (nothing was committed)", async () => {
      const { store } = fakeStore(sessionAt(CHUNK));
      stubUpload({ session: [reply(500, "oops")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "YOUTUBE_UPLOAD_FAILED", status: 500 });
    });

    it("a rate-limited status query is RATE_LIMITED, and the saved session is left as it was", async () => {
      const { store, mocks } = fakeStore(sessionAt(CHUNK));
      stubUpload({ session: [googleError(403, "userRateLimitExceeded")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "RATE_LIMITED", kind: "rate_limited" });
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("keeps resuming a saved session after the platform is switched off, whatever the size (never strands an upload)", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "none");
      const { store } = fakeStore(sessionAt(0, 4 * MIB));
      const upload = stubUpload({ total: 4 * MIB, session: [incomplete(), created("v1")] });

      const result = await run(bigCtx(store, {}, 4 * MIB));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(upload.statusQueries()).toHaveLength(1);
      expect(upload.starts()).toHaveLength(0);
    });
  });

  describe("an expired session (status 404)", () => {
    it("clears the state and returns a continuation: the NEXT step starts the new session (and spends its slot)", async () => {
      const { store, mocks, saved } = fakeStore(sessionAt(2 * CHUNK));
      const upload = stubUpload({ session: [reply(404)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ continuation: { resumeAt: null } });
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(saved()).toBeNull();
      // This step started nothing: no new session, no chunk, no blob read.
      expect(upload.starts()).toHaveLength(0);
      expect(upload.puts()).toHaveLength(0);
      expect(upload.blobGets()).toHaveLength(0);
    });

    it("the next step, finding no state, starts a new session from byte 0", async () => {
      const { store } = fakeStore(sessionAt(2 * CHUNK));
      stubUpload({ session: [reply(404)] });
      await run(bigCtx(store));
      vi.unstubAllGlobals();

      const next = stubUpload({ session: accepts(6) });
      const result = await run(bigCtx(store, { continuation: 1 }));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(next.starts()).toHaveLength(1);
      expect(next.statusQueries()).toHaveLength(0);
      expect(contentRange(next.puts()[0][1] as RequestInit)).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
    });

    it("drops saved state it cannot use (another size, no session URI, an http URI, no size) the same way", async () => {
      for (const unusable of [
        { data: { totalBytes: TOTAL + 1, confirmedBytes: 0 }, secret: { sessionUri: SESSION_URI } },
        { data: { totalBytes: TOTAL, confirmedBytes: 0 } },
        { data: { totalBytes: TOTAL, confirmedBytes: 0 }, secret: { sessionUri: "http://insecure.example/x" } },
        { data: {}, secret: { sessionUri: SESSION_URI } },
      ]) {
        const { store, mocks } = fakeStore(unusable);
        const upload = stubUpload();

        const result = await run(bigCtx(store));

        expect(result).toEqual({ continuation: { resumeAt: null } });
        expect(mocks.clear).toHaveBeenCalledTimes(1);
        expect(upload.fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
      }
    });

    it("a 404 on the status query after a failed chunk does the same", async () => {
      const { store, mocks, saved } = fakeStore();
      const upload = stubUpload({ session: [reply(503), reply(404)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ continuation: { resumeAt: null } });
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(saved()).toBeNull();
      expect(upload.starts()).toHaveLength(1);
    });
  });

  describe("rate limits", () => {
    it("a 429 on chunk 2 saves chunk 1 as confirmed, then throws RATE_LIMITED", async () => {
      const { store, mocks, saved } = fakeStore();
      stubUpload({ session: [acceptChunk, reply(429, "", { "Retry-After": "120" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "rate_limited" });
      expect((error as unknown as { retryAt: number }).retryAt).toBe(NOW + 120_000);
      expect(mocks.save).toHaveBeenCalledTimes(2); // the session, then this progress
      expect(saved()).toEqual({
        kind: "youtube_resumable",
        data: { totalBytes: TOTAL, confirmedBytes: CHUNK },
        secret: { sessionUri: SESSION_URI },
      });
    });

    it("a quota 403 on the first chunk saves the session as it stands and throws RATE_LIMITED youtube_quota", async () => {
      const { store, saved } = fakeStore();
      stubUpload({ session: [googleError(403, "quotaExceeded")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "RATE_LIMITED", kind: "youtube_quota" });
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: 0 });
    });

    it("a rate limit on the LAST chunk saves the progress and throws RATE_LIMITED (the chunk was rejected, not committed)", async () => {
      const { store, saved } = fakeStore(sessionAt(LAST_START));
      stubUpload({ session: [incomplete(LAST_START - 1), reply(429)] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: LAST_START });
    });

    it("still throws RATE_LIMITED when saving the progress fails (the next step asks the session anyway)", async () => {
      const { store, mocks } = fakeStore();
      stubUpload({ session: [reply(429)] });
      mocks.save
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(Object.assign(new Error("claim gone"), { code: "RESULT_CLAIM_LOST" }));

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
    });

    it("the deferred step resumes the saved session: a status query, no second start", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [acceptChunk, reply(429)] });
      await failure(bigCtx(store));
      vi.unstubAllGlobals();

      const retry = stubUpload({ session: [incomplete(CHUNK - 1), ...accepts(5)] });
      const result = await run(bigCtx(store, { continuation: 0 }));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(retry.starts()).toHaveLength(0);
      expect(headersOf(retry.blobGets()[0][1] as RequestInit)["Range"]).toBe(`bytes=${CHUNK}-`);
    });
  });

  describe("a chunk that gets no usable answer (not the last)", () => {
    it("pins the wait after a failure that says nothing about the upload: 30 s", () => {
      expect(YOUTUBE_TRANSIENT_RESUME_DELAY_MS).toBe(TRANSIENT_RESUME_DELAY);
    });

    it.each([
      ["a 503", () => reply(503, "unavailable")],
      ["a timeout", timeout],
      ["a dropped connection", connectionReset],
    ] as const)("%s: asks the session where it stands, then resumes from its Range", async (_name, bad) => {
      const { store } = fakeStore();
      const upload = stubUpload({
        // Chunk 1 fails; the session had received 4 MiB of it.
        session: [bad(), incomplete(4 * MIB - 1), ...accepts(6)],
      });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(upload.statusQueries()).toHaveLength(1);
      const puts = upload.puts();
      expect(contentRange(puts[1][1] as RequestInit)).toBe(`bytes ${4 * MIB}-${CHUNK - 1}/${TOTAL}`);
      expectBodyFrom(puts[1], 4 * MIB);
      expect(upload.blobGets()).toHaveLength(1);
    });

    it(`recovers ${YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP} times in a step; the next failure saves and continues 30 s later without asking again`, async () => {
      const { store, saved } = fakeStore();
      const upload = stubUpload({ session: [reply(503), incomplete(), reply(503), incomplete(), reply(503)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(3);
      expect(upload.statusQueries()).toHaveLength(2);
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: 0 });
    });

    it("a 308 that confirms nothing new counts as a recovery, so it cannot loop (and the next step waits 30 s)", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ session: [incomplete(), incomplete(), incomplete()] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(3);
    });

    it("a chunk that fails with a TypeError that is not undici's network failure is a bug: it surfaces, with no status query", async () => {
      const { store } = fakeStore(sessionAt(CHUNK));
      const bug = new TypeError("x is not a function");
      const upload = stubUpload({ session: [incomplete(CHUNK - 1), failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
      expect(upload.statusQueries()).toHaveLength(1); // only the one at the start of the step
    });

    it("a status query that fails with a TypeError that is not undici's network failure surfaces instead of pausing", async () => {
      const { store } = fakeStore();
      const bug = new TypeError("x is not a function");
      stubUpload({ session: [reply(503), failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
    });

    it("a status query that fails with a 4xx after a bad chunk is an ordinary failure (nothing was committed)", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [reply(503), reply(403, "{}")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "YOUTUBE_UPLOAD_FAILED", status: 403 });
    });

    it("a status query that says complete after a bad chunk returns the video", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [timeout(), created("surprise")] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "surprise" });
    });
  });

  // 2026-11-02 scale audit (jobs B3): a chunk that is not the last is never committed, so a
  // failure near the deadline is not a failure of the upload. The step saves and continues:
  // the next step begins with a status query anyway, and a failed result would throw away
  // everything uploaded so far (the state is cleared with it).
  describe("a chunk that is not the last runs into the step deadline", () => {
    const paused = { continuation: { resumeAt: null } };
    const progress = (confirmedBytes: number) => ({ totalBytes: TOTAL, confirmedBytes });

    it.each([
      ["times out when the budget ends", () => timeout()],
      ["gets a 503 as the budget ends", () => reply(503, "unavailable")],
      ["loses its connection as the budget ends", () => connectionReset()],
    ] as const)("a chunk that %s saves and continues, and asks no status query", async (_name, bad) => {
      const { store, saved } = fakeStore();
      // The chunk runs to 2 s before the deadline: too little for a status query (5 s) - and for another chunk.
      const upload = stubUpload({ session: [after(STEP - 2_000, bad())] });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(1);
      expect(upload.statusQueries()).toHaveLength(0);
      expect(saved()?.data).toEqual(progress(0));
      expect(saved()?.secret).toEqual({ sessionUri: SESSION_URI });
    });

    it("pauses when under 60 s are left after the failure - no other chunk could be sent - and asks the status query at exactly 60 s", async () => {
      const a = fakeStore();
      const short = stubUpload({ session: [after(STEP - 59_999, reply(503))] });
      expect(await run(bigCtx(a.store, { deadline: NOW + STEP }))).toEqual(paused);
      expect(short.statusQueries()).toHaveLength(0);
      expect(a.mocks.clear).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const b = fakeStore();
      const enough = stubUpload({ session: [after(STEP - 60_000, reply(503)), incomplete(), ...accepts(6)] });
      await run(bigCtx(b.store, { deadline: NOW + STEP }));
      expect(enough.statusQueries()).toHaveLength(1);
    });

    it("keeps what an earlier chunk of the step already uploaded", async () => {
      const { store, saved } = fakeStore();
      stubUpload({ session: [acceptChunk, after(STEP - 2_000, timeout())] });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual(paused);
      expect(saved()?.data).toEqual(progress(CHUNK));
    });

    it("a chunk that was never sent because the budget ran out while the blob was read pauses too (no PUT, nothing lost)", async () => {
      const { store, saved } = fakeStore();
      // The window check passes (225 s left); reading the chunk then takes all but 3 s.
      const upload = stubUpload({ blobAdvance: STEP - 3_000 });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(0);
      expect(saved()?.data).toEqual(progress(0));
    });

    it("a connection that never reached YouTube with under 60 s left pauses; with time left it is still rethrown unchanged for the in-step retry", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      const a = fakeStore();
      stubUpload({ session: [after(STEP - 30_000, failWith(neverConnected))] });
      expect(await run(bigCtx(a.store, { deadline: NOW + STEP }))).toEqual(paused);
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const b = fakeStore();
      stubUpload({ session: [failWith(neverConnected)] });
      expect(await failure(bigCtx(b.store, { deadline: NOW + STEP }))).toBe(neverConnected);
    });

    it.each([
      ["a 503", () => reply(503, "unavailable")],
      ["a 502", () => reply(502, "bad gateway")],
      ["a timeout", () => timeout()],
      ["a dropped connection", () => connectionReset()],
      ["a body cut off by undici", () => failWith(new TypeError("terminated"))],
    ] as const)("%s on the recovery status query saves and continues 30 s later (the next step asks again) instead of failing the upload", async (_name, bad) => {
      const { store, saved, mocks } = fakeStore();
      // Plenty of time for the status query, so it is asked; it fails.
      const upload = stubUpload({ session: [after(STEP - 100_000, reply(503)), bad()] });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.statusQueries()).toHaveLength(1);
      expect(saved()?.data).toEqual(progress(0));
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("and the next step resumes from the session", async () => {
      const { store } = fakeStore();
      stubUpload({ session: [reply(503), reply(503)] });
      expect(await run(bigCtx(store, { deadline: NOW + STEP }))).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const next = stubUpload({ session: [incomplete(2 * MIB - 1), ...accepts(6)] });
      const result = await run(bigCtx(store, { deadline: NOW + 400_000 + STEP, continuation: 1 }));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(next.starts()).toHaveLength(0);
      expect(contentRange(next.puts()[0][1] as RequestInit)).toBe(`bytes ${2 * MIB}-${2 * MIB + CHUNK - 1}/${TOTAL}`);
    });

    it("still fails the upload for a status query that is rejected for good (a 4xx), or a rate limit still defers", async () => {
      const a = fakeStore();
      stubUpload({ session: [reply(503), reply(401, "{}")] });
      expect(await failure(bigCtx(a.store, { deadline: NOW + STEP }))).toMatchObject({
        code: "YOUTUBE_UPLOAD_FAILED",
        status: 401,
      });
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const b = fakeStore();
      stubUpload({ session: [reply(503), reply(429)] });
      expect((await failure(bigCtx(b.store, { deadline: NOW + STEP })))?.code).toBe("RATE_LIMITED");
    });

    it("the last chunk keeps its own rules: a timeout at the deadline is settled by the status query, or PUBLISH_UNCONFIRMED - never a pause", async () => {
      const a = fakeStore(sessionAt(LAST_START));
      // 12 s left after the chunk: time for the status query, which says 201.
      stubUpload({ session: [incomplete(LAST_START - 1), after(STEP - 12_000, timeout()), created("late")] });
      expect(await run(bigCtx(a.store, { deadline: NOW + STEP }))).toEqual({ externalPostId: "late" });
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const b = fakeStore(sessionAt(LAST_START));
      const upload = stubUpload({ session: [incomplete(LAST_START - 1), after(STEP - 3_000, timeout())] });
      expect((await failure(bigCtx(b.store, { deadline: NOW + STEP })))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.statusQueries()).toHaveLength(1);
    });
  });

  describe("the last chunk is the commit call", () => {
    /** A saved session that holds all but the last 10 MiB. */
    const atLastChunk = () => fakeStore(sessionAt(LAST_START));
    const statusAtLast = incomplete(LAST_START - 1);

    it("a 201 is success", async () => {
      const { store } = atLastChunk();
      const upload = stubUpload({ session: [statusAtLast, created("final")] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "final" });
      expect(upload.puts()).toHaveLength(1);
    });

    it.each([
      ["a 503", () => reply(503, "unavailable")],
      ["a timeout", timeout],
      ["a dropped connection", connectionReset],
    ] as const)("%s, then a status query that says 201 with the video: success with its id, not unconfirmed", async (_name, bad) => {
      const { store } = atLastChunk();
      const upload = stubUpload({ session: [statusAtLast, bad(), created("v1")] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(upload.puts()).toHaveLength(1);
      expect(upload.statusQueries()).toHaveLength(2);
      expect(contentRange(upload.statusQueries()[1][1] as RequestInit)).toBe(`bytes */${TOTAL}`);
    });

    it("a 503, then a status query that says 200: success too", async () => {
      const { store } = atLastChunk();
      stubUpload({ session: [statusAtLast, reply(503), reply(200, JSON.stringify({ id: "v200" }))] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "v200" });
    });

    it("a 503, then a status query that times out -> PUBLISH_UNCONFIRMED", async () => {
      const { store } = atLastChunk();
      stubUpload({ session: [statusAtLast, reply(503), timeout()] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    });

    it("a status query that hangs is cut off at its 15 s timeout, and the result is PUBLISH_UNCONFIRMED", async () => {
      vi.useRealTimers();
      vi.useFakeTimers(); // the status timeout itself needs a clock that can be moved
      vi.setSystemTime(NOW);
      const { store } = atLastChunk();
      const hang: Reply = ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      stubUpload({ session: [statusAtLast, reply(503), hang] });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      let error: CodedError | null | undefined;
      const pending = failure(bigCtx(store, { deadline: NOW + STEP })).then((e) => {
        error = e;
      });
      for (let i = 0; i < 40 && error === undefined; i += 1) await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toContain(YOUTUBE_STATUS_TIMEOUT_MS);
    });

    it.each([
      ["a 404 (the session is gone)", reply(404)],
      ["a 500", reply(500)],
      ["a 429", reply(429)],
      ["a 403 quota", googleError(403, "quotaExceeded")],
      ["a 201 without an id", reply(201, "{}")],
      ["a network error", connectionReset()],
      ["a 308 whose Range is unreadable", reply(308, null, { Range: "garbage" })],
    ] as const)("a 503, then a status query answering %s -> PUBLISH_UNCONFIRMED (never RATE_LIMITED, never a retry)", async (_name, status) => {
      const { store } = atLastChunk();
      const upload = stubUpload({ session: [statusAtLast, reply(503), status] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.puts()).toHaveLength(1);
    });

    it("a 503, then 308 (the upload is incomplete): resends the rest from the buffer and succeeds", async () => {
      const { store } = atLastChunk();
      const upload = stubUpload({
        session: [statusAtLast, reply(503), incomplete(LAST_START + MIB - 1), created("v2")],
      });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "v2" });
      const puts = upload.puts();
      expect(puts).toHaveLength(2);
      expect(contentRange(puts[0][1] as RequestInit)).toBe(`bytes ${LAST_START}-${TOTAL - 1}/${TOTAL}`);
      expect(contentRange(puts[1][1] as RequestInit)).toBe(`bytes ${LAST_START + MIB}-${TOTAL - 1}/${TOTAL}`);
      expect(((puts[1][1] as RequestInit).body as Buffer).length).toBe(TOTAL - LAST_START - MIB);
      expectBodyFrom(puts[1], LAST_START + MIB);
      expect(upload.blobGets()).toHaveLength(1);
    });

    it("resends a bounded number of times: once the recoveries are spent it saves and continues 30 s later (nothing was committed)", async () => {
      const { store, saved } = atLastChunk();
      const upload = stubUpload({
        session: [
          statusAtLast,
          reply(503),
          incomplete(LAST_START - 1),
          reply(503),
          incomplete(LAST_START - 1),
          reply(503),
          incomplete(LAST_START + MIB - 1),
        ],
      });

      const result = await run(bigCtx(store));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(3);
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: LAST_START + MIB });
    });

    it("a 4xx is a rejection, not a commit: YOUTUBE_UPLOAD_FAILED, and no status query follows", async () => {
      const { store } = atLastChunk();
      const upload = stubUpload({ session: [statusAtLast, reply(400, "{}")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "YOUTUBE_UPLOAD_FAILED", status: 400 });
      expect(upload.statusQueries()).toHaveLength(1); // only the one at the start of the step
    });

    it("a 429 is RATE_LIMITED (rejected, not committed) after the progress is saved", async () => {
      const { store, mocks } = atLastChunk();
      stubUpload({ session: [statusAtLast, reply(429)] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(mocks.save).toHaveBeenCalled();
    });

    it("a 201 with an unreadable body, or without an id, is PUBLISH_UNCONFIRMED (the video exists)", async () => {
      for (const body of ["<html>ok</html>", "{}", JSON.stringify({ id: "" })]) {
        const { store } = atLastChunk();
        stubUpload({ session: [statusAtLast, reply(201, body)] });

        expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
        vi.unstubAllGlobals();
      }
    });

    it("a connection that never reached YouTube is rethrown unchanged: it is provably unsent", async () => {
      const { store } = atLastChunk();
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      stubUpload({ session: [statusAtLast, failWith(neverConnected)] });

      expect(await failure(bigCtx(store))).toBe(neverConnected);
    });

    it("a 503 with no time left for the status query -> PUBLISH_UNCONFIRMED, and no status request is sent", async () => {
      const { store } = atLastChunk();
      const upload = stubUpload({
        session: [
          statusAtLast,
          // The chunk ate the budget: 3 s are left, under the 5 s a request needs.
          after(STEP - 3_000, reply(503)),
        ],
      });

      const error = await failure(bigCtx(store, { deadline: NOW + STEP }));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.statusQueries()).toHaveLength(1); // the one at the start of the step
    });

    it("starts only with YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS (90 s) left: 80 s -> continuation, and the last PUT is not sent", async () => {
      const { store, saved } = atLastChunk();
      const upload = stubUpload({ session: [statusAtLast] });

      const result = await run(bigCtx(store, { deadline: NOW + 80_000 }));

      expect(result).toEqual({ continuation: { resumeAt: null } });
      expect(upload.puts()).toHaveLength(0);
      expect(upload.blobGets()).toHaveLength(0);
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: LAST_START });
    });

    it("the 90 s edge: 89.999 s is too little, exactly 90 s sends the chunk", async () => {
      expect(YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS).toBe(90_000);
      const tooLate = atLastChunk();
      const first = stubUpload({ session: [statusAtLast] });
      expect(await run(bigCtx(tooLate.store, { deadline: NOW + 89_999 }))).toEqual({ continuation: { resumeAt: null } });
      expect(first.puts()).toHaveLength(0);
      vi.unstubAllGlobals();

      const justEnough = atLastChunk();
      const second = stubUpload({ session: [statusAtLast, created()] });
      expect(await run(bigCtx(justEnough.store, { deadline: NOW + 90_000 }))).toEqual({ externalPostId: "v1" });
      expect(second.puts()).toHaveLength(1);
    });

    it("cuts the chunk's own timeout 15 s short of the deadline, so the status query can still be asked", async () => {
      const { store } = atLastChunk();
      stubUpload({ session: [statusAtLast, created()] });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      await run(bigCtx(store, { deadline: NOW + 100_000 }));

      // The last chunk: min(120 s, 100 s - 15 s). The status query: min(15 s, 100 s).
      const timers = setTimeoutSpy.mock.calls.map((c) => c[1]);
      expect(timers).toContain(85_000);
      expect(timers).toContain(YOUTUBE_STATUS_TIMEOUT_MS);
    });
  });

  describe("the step window for chunks that are not the last", () => {
    it(`needs ${LARGE_UPLOAD_CHUNK_WINDOW_MS / 1000} s left: with 59.999 s the chunk is not read or sent, with exactly 60 s it is`, async () => {
      const a = fakeStore(sessionAt(0));
      const early = stubUpload({ session: [incomplete()] });
      expect(await run(bigCtx(a.store, { deadline: NOW + 59_999 }))).toEqual({ continuation: { resumeAt: null } });
      expect(early.puts()).toHaveLength(0);
      expect(early.blobGets()).toHaveLength(0);
      expect(a.saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: 0 });
      vi.unstubAllGlobals();

      const b = fakeStore(sessionAt(0));
      const ok = stubUpload({ session: [incomplete(), ...accepts(6)] });
      await run(bigCtx(b.store, { deadline: NOW + 60_000 }));
      expect(ok.puts().length).toBeGreaterThan(0);
    });

    it("a short window right after the session is started still saves it, so the next step resumes (it never starts a second)", async () => {
      const { store, saved } = fakeStore();
      const upload = stubUpload();

      const result = await run(bigCtx(store, { deadline: NOW + 30_000 }));

      expect(result).toEqual({ continuation: { resumeAt: null } });
      expect(upload.puts()).toHaveLength(0);
      expect(saved()?.secret).toEqual({ sessionUri: SESSION_URI });
    });
  });

  describe("secrets", () => {
    it("the session URI is never in a console call or an error, across retries, a rate limit and a restart", async () => {
      const scenarios: Array<{ session: Reply[]; initial?: { data: unknown; secret?: unknown } }> = [
        { session: [reply(503), incomplete(MIB - 1), ...accepts(6)] },
        { session: [acceptChunk, reply(429)] },
        { session: [reply(404)], initial: sessionAt(CHUNK) },
        { session: [incomplete(LAST_START - 1), reply(503), reply(404)], initial: sessionAt(LAST_START) },
        { session: [incomplete(), incomplete(), incomplete()] },
      ];
      const outcomes: unknown[] = [];
      for (const scenario of scenarios) {
        const { store } = fakeStore(scenario.initial);
        stubUpload({ session: scenario.session });
        outcomes.push(
          await run(bigCtx(store)).catch((e: unknown) => ({ code: (e as CodedError).code, message: (e as Error).message })),
        );
        vi.unstubAllGlobals();
      }

      expect(everythingLogged()).not.toContain("SESSION-SECRET");
      expect(JSON.stringify(outcomes)).not.toContain("SESSION-SECRET");
      // What is logged is progress.
      expect(everythingLogged()).toContain("confirmedBytes");
      expect(everythingLogged()).toContain("totalBytes");
    });

    it("an access token is never in a log either", async () => {
      const { store } = fakeStore();
      stubUpload({ session: accepts(6) });

      await run(bigCtx(store));

      expect(everythingLogged()).not.toContain("access-token");
    });
  });

  describe("tokens", () => {
    const expiringIn = (ms: number, overrides: Partial<PublishContext> = {}, sizeBytes = TOTAL) => {
      const ctx = bigCtx(overrides.uploadState, overrides, sizeBytes);
      return {
        ...ctx,
        socialConnection: { ...ctx.socialConnection, expiresAt: new Date(NOW + ms) },
      } as PublishContext;
    };
    const refreshed = {
      id: "conn-yt",
      platform: "youtube",
      accessToken: "fresh-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(NOW + 3_600_000),
    };

    it("refreshes a token that would expire before the step ends, so a chunk is never rejected mid-step", async () => {
      const { store } = fakeStore();
      refreshConnectionTokenMock.mockResolvedValueOnce(refreshed);
      const upload = stubUpload({ session: accepts(6) });

      await run(expiringIn(120_000, { uploadState: store, deadline: NOW + STEP }));

      expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
      expect(headersOf(upload.starts()[0][1] as RequestInit).Authorization).toBe("Bearer fresh-token");
      expect(headersOf(upload.puts()[0][1] as RequestInit).Authorization).toBe("Bearer fresh-token");
    });

    it("leaves a token that outlives the step alone", async () => {
      const { store } = fakeStore();
      stubUpload({ session: accepts(6) });

      await run(expiringIn(STEP + 60_000, { uploadState: store, deadline: NOW + STEP }));

      expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    });

    it("the multipart path keeps refreshing only a token that has already expired", async () => {
      stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      await run(expiringIn(120_000, { deadline: NOW + STEP }, 4));

      expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    });
  });

  describe("small files and platforms that are not enabled keep the multipart upload", () => {
    const multipartOnly = (fetchMock: ReturnType<typeof stubYouTube>) => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u.includes("uploadType=multipart"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("uploadType=resumable"))).toHaveLength(0);
    };

    it("a video of 50 MiB or less sends exactly one multipart request, even with a store and YouTube enabled", async () => {
      const { store, mocks } = fakeStore();
      const fetchMock = stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      const result = await run(bigCtx(store, {}, LARGE_VIDEO_THRESHOLD_BYTES));

      expect(result).toEqual({ externalPostId: "vid-1" });
      multipartOnly(fetchMock);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("one byte over the threshold starts a resumable session", async () => {
      const { store } = fakeStore();
      const size = LARGE_VIDEO_THRESHOLD_BYTES + 1;
      const upload = stubUpload({ total: size, session: accepts(4) });

      const result = await run(bigCtx(store, {}, size));

      expect(result).toEqual({ externalPostId: "v1" });
      expect(upload.starts()).toHaveLength(1);
      expect(upload.puts()).toHaveLength(4);
    });

    it("a large video on a platform that is not enabled keeps the multipart upload", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "x,tiktok");
      const { store } = fakeStore();
      const fetchMock = stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      await run(bigCtx(store));

      multipartOnly(fetchMock);
    });

    it("the default (LARGE_UPLOAD_PLATFORMS unset) keeps the multipart upload", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "");
      const { store } = fakeStore();
      const fetchMock = stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      await run(bigCtx(store));

      multipartOnly(fetchMock);
    });

    it("a large video with no store (a direct caller) keeps the multipart upload", async () => {
      const fetchMock = stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      await run(bigCtx(undefined));

      multipartOnly(fetchMock);
    });

    it("looks for saved state of its own kind", async () => {
      const { store, mocks } = fakeStore();
      stubYouTube(() => new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }));

      await run(bigCtx(store, {}, 4));

      expect(mocks.load).toHaveBeenCalledWith(YOUTUBE_UPLOAD_STATE_KIND);
    });
  });

  describe("blob reads", () => {
    it("a body that drops part-way through pauses 30 s with the saved session intact (nothing of the chunk was sent)", async () => {
      const { store, saved, mocks } = fakeStore(sessionAt(CHUNK));
      const upload = stubUpload({ session: [incomplete(CHUNK - 1)], blobBodyFailure: new TypeError("terminated") });

      const result = await run(bigCtx(store));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(0);
      expect(saved()).toEqual({ kind: YOUTUBE_UPLOAD_STATE_KIND, ...sessionAt(CHUNK) });
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("a body cut off by the step deadline pauses at once, not 30 s later", async () => {
      const { store, saved } = fakeStore(sessionAt(CHUNK));
      const upload = stubUpload({
        session: [incomplete(CHUNK - 1)],
        blobAdvance: STEP - 30_000,
        blobBodyFailure: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      });

      const result = await run(bigCtx(store, { deadline: NOW + STEP }));

      expect(result).toEqual({ continuation: { resumeAt: null } });
      expect(upload.puts()).toHaveLength(0);
      expect(saved()?.data).toEqual({ totalBytes: TOTAL, confirmedBytes: CHUNK });
    });

    it("a blob that refuses the Range read (a 4xx) still fails, it does not pause", async () => {
      const { store } = fakeStore(sessionAt(CHUNK));
      const upload = stubUpload({ session: [incomplete(CHUNK - 1)], blobStatus: 403 });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "BLOB_READ_FAILED", status: 403 });
      expect(upload.puts()).toHaveLength(0);
    });

    it("a blob that cannot be read fails before a single chunk is sent", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ blobStatus: 500 });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("BLOB_READ_FAILED");
      expect(upload.puts()).toHaveLength(0);
    });

    it("a blob whose size differs from the recorded one fails MEDIA_SIZE_MISMATCH before any chunk", async () => {
      const { store } = fakeStore();
      const upload = stubUpload({ total: TOTAL + 5 });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("MEDIA_SIZE_MISMATCH");
      expect(upload.puts()).toHaveLength(0);
    });
  });
});
