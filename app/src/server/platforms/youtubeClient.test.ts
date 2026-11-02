import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
import { nextPacificMidnight, PACIFIC_RESET_GRACE_MS } from "./rateLimited";
import { withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import { computeYouTubeTitle, youtubeClient } from "./youtubeClient";

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

  // 2026-11-02 scale audit (jobs, R30): the insert answered 2xx ("created") but
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
