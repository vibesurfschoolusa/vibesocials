import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { truncateGraphemes } from "@/lib/truncate";
import type { UploadStateStore } from "@/server/jobs/uploadState";

import { LARGE_UPLOAD_CHUNK_WINDOW_MS, LARGE_VIDEO_THRESHOLD_BYTES } from "./largeUpload";
import { PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
import { withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import {
  computeTweetText,
  X_APP_NOT_ENROLLED_MESSAGE,
  X_CREDITS_EXHAUSTED_MESSAGE,
  X_APPEND_SEGMENT_BYTES,
  X_DEFAULT_MEDIA_EXPIRES_SECS,
  X_LARGE_PROCESSING_MAX_MS,
  X_LARGE_STATUS_MAX_INTERVAL_MS,
  X_LARGE_STATUS_MIN_INTERVAL_MS,
  X_MEDIA_EXPIRY_SAFETY_MS,
  X_PROCESSING_MAX_WAIT_MS,
  X_STATUS_MAX_INTERVAL_MS,
  X_TRANSIENT_RESUME_DELAY_MS,
  X_TWEET_MIN_WINDOW_MS,
  X_TWEET_RESERVE_MS,
  X_UPLOAD_STATE_KIND,
  xClient,
} from "./xClient";

// Roadmap Phase 7 (spec §7.1) — this locks computeTweetText (extracted from
// publishVideo when it was refactored to read its limit/ellipsis from
// lib/platformLimits.ts instead of inline `280` / `"..."` literals) to the
// EXACT same output as the pre-refactor inline block:
//
//   let tweetText = caption;
//   if (tweetText.length > 280) {
//     const truncated = truncateGraphemes(tweetText, 280, { ellipsis: "..." });
//     if (truncated !== tweetText) tweetText = truncated;
//   }
//
// If this ever fails, either the refactor broke posting behavior or someone
// edited PLATFORM_CAPTION_LIMITS.x without meaning to change what X posts.
describe("computeTweetText", () => {
  it("returns a caption under 280 graphemes unchanged", () => {
    const caption = "Just a short caption";
    expect(computeTweetText(caption)).toBe(caption);
  });

  it("returns a caption at exactly 280 graphemes unchanged (boundary)", () => {
    const caption = "a".repeat(280);
    expect(computeTweetText(caption)).toBe(caption);
  });

  it("truncates a caption of length 300 to 280 graphemes with a '...' ellipsis", () => {
    const caption = "a".repeat(300);
    const result = computeTweetText(caption);
    expect(result).toHaveLength(280);
    expect(result).toBe("a".repeat(277) + "...");
  });

  it("matches the pre-refactor inline call byte-for-byte for a realistic long caption", () => {
    const caption = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    expect(caption.length).toBeGreaterThan(280);
    expect(computeTweetText(caption)).toBe(
      truncateGraphemes(caption, 280, { ellipsis: "..." }),
    );
  });

  it("matches the pre-refactor inline call byte-for-byte for emoji/ZWJ-heavy content over the limit", () => {
    // Astral (surrogate-pair) graphemes are exactly where a re-implementation
    // could diverge from the original `.length > 280` UTF-16 pre-check.
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(60);
    expect(caption.length).toBeGreaterThan(280);
    expect(computeTweetText(caption)).toBe(
      truncateGraphemes(caption, 280, { ellipsis: "..." }),
    );
  });

  it("empty caption stays empty (no crash, no spurious ellipsis)", () => {
    expect(computeTweetText("")).toBe("");
  });
});

// 2026-11-01 audit (Task 4 item 7): one X step (download + chunked upload +
// media-processing poll + tweet + in-step retries) must end well inside
// Vercel's 300s cap. The processing poll used to allow 60 x (check_after_secs
// + a 30s request) — over 300s by itself. No real X endpoint is called: every
// request goes through a stubbed global fetch, routed by URL + command.
describe("xClient.publishVideo — media-processing poll + step budget", () => {
  type Route = (init?: RequestInit) => Promise<Response>;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const now = (make: () => Response): Route => async () => make();
  /** Resolve after `ms` of (fake) time, or reject if the request is aborted first. */
  const slow = (ms: number, make: () => Response): Route => (init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  const processing = (state: string, checkAfterSecs = 5) =>
    json({ media_id_string: "m1", processing_info: { state, check_after_secs: checkAfterSecs } });

  function ctx(deadline?: number): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-x",
        platform: "x",
        accessToken: "access-token",
        refreshToken: "access-token-secret",
      } as unknown as SocialConnection,
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: {
        mimeType: "video/mp4",
        storageLocation: "https://blob.example.com/v.mp4",
        sizeBytes: 4,
        originalFilename: "v.mp4",
      } as unknown as MediaItem,
      caption: "hello",
      ...(deadline !== undefined ? { deadline } : {}),
    };
  }

  function stubX(routes: { download?: Route; append?: Route; finalize?: Route; status: Route }) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" || init?.body instanceof URLSearchParams ? String(init.body) : "";
      if (url.includes("blob.example.com")) {
        return (routes.download ?? now(() => new Response(new Uint8Array([1, 2, 3, 4]))))(init);
      }
      if (url.includes("command=STATUS")) return routes.status(init);
      if (url.includes("upload.twitter.com")) {
        if (body.includes("command=INIT")) return Promise.resolve(json({ media_id_string: "m1" }));
        if (body.includes("command=APPEND")) {
          return (routes.append ?? now(() => new Response(null, { status: 204 })))(init);
        }
        if (body.includes("command=FINALIZE")) {
          return (routes.finalize ?? now(() => processing("pending")))(init);
        }
      }
      if (url.includes("statuses/update.json")) return Promise.resolve(json({ id_str: "tweet-1" }));
      if (url.includes("/2/tweets")) return Promise.resolve(json({ data: { id: "tweet-2", text: "x" } }));
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const tweetCalls = (fetchMock: ReturnType<typeof stubX>) =>
    fetchMock.mock.calls.filter((c) => /statuses\/update|\/2\/tweets/.test(String(c[0])));

  /** Run publishVideo under fake timers; returns its result or error and when it settled. */
  async function run(c: PublishContext, advanceMs = 600_000) {
    let settledAt = 0;
    const promise = xClient.publishVideo(c).then(
      (result) => {
        settledAt = Date.now();
        return { result, error: null };
      },
      (e: unknown) => {
        settledAt = Date.now();
        return { result: null, error: e as Error & { code?: string } };
      },
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    return { ...(await promise), settledAt };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("X_CONSUMER_KEY", "consumer-key");
    vi.stubEnv("X_CONSUMER_SECRET", "consumer-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("budget constants: <=120s of processing wait, <=15s per wait, 20s kept back for the tweet", () => {
    expect(X_PROCESSING_MAX_WAIT_MS).toBe(120_000);
    expect(X_STATUS_MAX_INTERVAL_MS).toBe(15_000);
    expect(X_TWEET_RESERVE_MS).toBe(20_000);
  });

  it("publishes once processing succeeds (happy path)", async () => {
    stubX({ status: now(() => json({ processing_info: { state: "succeeded" } })) });

    const { result, error } = await run(ctx(Date.now() + PUBLISH_STEP_BUDGET_MS));

    expect(error).toBeNull();
    expect(result).toEqual({ externalPostId: "tweet-1" });
  });

  it("gives up on a video X never finishes processing within the processing cap, without tweeting", async () => {
    const start = Date.now();
    const fetchMock = stubX({ status: now(() => processing("in_progress")) });

    const { error, settledAt } = await run(ctx());

    expect(error?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
    expect(error?.message).toMatch(/still processing/i);
    expect(settledAt - start).toBeLessThanOrEqual(X_PROCESSING_MAX_WAIT_MS);
    expect(tweetCalls(fetchMock)).toHaveLength(0);
  });

  it("clamps an outsized check_after_secs to 15s between checks", async () => {
    const start = Date.now();
    stubX({
      finalize: now(() => processing("pending", 600)),
      status: now(() => json({ processing_info: { state: "succeeded" } })),
    });

    const { result, settledAt } = await run(ctx());

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(settledAt - start).toBeLessThanOrEqual(X_STATUS_MAX_INTERVAL_MS);
  });

  it("stops polling early enough to keep the tweet reserve before a tight step deadline", async () => {
    const deadline = Date.now() + 60_000;
    const fetchMock = stubX({ status: now(() => processing("in_progress")) });

    const { error, settledAt } = await run(ctx(deadline));

    expect(error?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
    expect(settledAt).toBeLessThanOrEqual(deadline - X_TWEET_RESERVE_MS);
    expect(tweetCalls(fetchMock)).toHaveLength(0);
  });

  it("worst case: a slow download + upload and endless processing still end by the step deadline (< 240s)", async () => {
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    stubX({
      download: slow(110_000, () => new Response(new Uint8Array([1, 2, 3, 4]))),
      append: slow(80_000, () => new Response(null, { status: 204 })),
      status: now(() => processing("in_progress")),
    });

    const { error, settledAt } = await run(ctx(deadline));

    // Polling began ~190s in; the old 60-attempt loop would have run for minutes.
    expect(error?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });

  it("refuses to start once the step budget is spent (nothing sent, nothing posted)", async () => {
    const fetchMock = stubX({ status: now(() => processing("in_progress")) });

    const { error } = await run(ctx(Date.now() + 1_000));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails fast when X reports the processing state as failed", async () => {
    const fetchMock = stubX({ status: now(() => json({ processing_info: { state: "failed" } })) });

    const { error } = await run(ctx());

    expect(error?.code).toBe("X_VIDEO_PROCESSING_FAILED");
    expect(tweetCalls(fetchMock)).toHaveLength(0);
  });
});


// 2026-11-01 scale audit (platform limits, V13): X answers an exhausted limit
// with HTTP 429 and `x-rate-limit-reset` (epoch seconds). Every X API call is
// classified into a RATE_LIMITED error — never an in-step retry, never the
// generic *_FAILED code — except the v1.1 statuses/update call, which keeps
// falling back to v2 on any non-5xx error.
describe("xClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  type Route = () => Response;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const limited = (headers: Record<string, string> = {}) => new Response("", { status: 429, headers });

  function ctx(mimeType: string): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-x",
        platform: "x",
        accessToken: "access-token",
        refreshToken: "access-token-secret",
      } as unknown as SocialConnection,
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        sizeBytes: 4,
        originalFilename: "m",
      } as unknown as MediaItem,
      caption: "hello",
    };
  }

  /** Route by URL + command; anything not given succeeds. */
  function stubX(routes: {
    image?: Route;
    init?: Route;
    append?: Route;
    finalize?: Route;
    status?: Route;
    v1?: Route;
    v2?: Route;
  }) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" || init?.body instanceof URLSearchParams ? String(init.body) : "";
      if (url.includes("blob.example.com")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
      if (url.includes("command=STATUS")) {
        return Promise.resolve((routes.status ?? (() => json({ processing_info: { state: "succeeded" } })))());
      }
      if (url.includes("upload.twitter.com")) {
        if (body.includes("command=INIT")) return Promise.resolve((routes.init ?? (() => json({ media_id_string: "m1" })))());
        if (body.includes("command=APPEND")) {
          return Promise.resolve((routes.append ?? (() => new Response(null, { status: 204 })))());
        }
        if (body.includes("command=FINALIZE")) {
          return Promise.resolve(
            (routes.finalize ?? (() => json({ media_id_string: "m1" })))(),
          );
        }
        return Promise.resolve((routes.image ?? (() => json({ media_id_string: "m1" })))());
      }
      if (url.includes("statuses/update.json")) {
        return Promise.resolve((routes.v1 ?? (() => json({ errors: [] }, 403)))());
      }
      if (url.includes("/2/tweets")) {
        return Promise.resolve((routes.v2 ?? (() => json({ data: { id: "tweet-2", text: "x" } }, 201)))());
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function failure(c: PublishContext) {
    return xClient.publishVideo(c).then(
      () => null,
      (e: unknown) => e as Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string },
    );
  }

  beforeEach(() => {
    vi.stubEnv("X_CONSUMER_KEY", "consumer-key");
    vi.stubEnv("X_CONSUMER_SECRET", "consumer-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("v2 tweet 429 -> RATE_LIMITED with retryAt from x-rate-limit-reset", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 600;
    stubX({ v2: () => limited({ "x-rate-limit-reset": String(resetSec) }) });

    const error = await failure(ctx("image/jpeg"));

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      platform: "x",
      kind: "rate_limited",
      retryAt: resetSec * 1000,
    });
    expect(error?.message).toBe("X is limiting requests right now.");
  });

  it("v1.1 statuses/update still falls back to v2 on a 429 (untouched call site)", async () => {
    const fetchMock = stubX({ v1: () => limited(), v2: () => json({ data: { id: "tweet-2", text: "x" } }, 201) });

    await expect(xClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({ externalPostId: "tweet-2" });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/2/tweets"))).toBe(true);
  });

  it("a v2 tweet failure that is not a rate limit keeps X_TWEET_FAILED", async () => {
    stubX({ v2: () => json({ title: "Forbidden" }, 403) });

    expect((await failure(ctx("image/jpeg")))?.code).toBe("X_TWEET_FAILED");
  });

  // 2026-11-08 live post: X answered exactly this when the developer app had no
  // pay-per-use access. The user must add credits in console.x.com.
  it("a v2 403 client-not-enrolled says to add API credits (X_APP_NOT_ENROLLED)", async () => {
    stubX({
      v2: () =>
        json(
          {
            client_id: "31885817",
            detail:
              "When authenticating requests to the X API v2 endpoints, you must use keys and tokens from a developer App that is attached to a Project. You can create a project via the developer portal.",
            reason: "client-not-enrolled",
            required_enrollment: "Appropriate Level of API Access",
            title: "Client Forbidden",
            type: "https://api.x.com/2/problems/client-forbidden",
          },
          403,
        ),
    });

    const error = await failure(ctx("image/jpeg"));

    expect(error?.code).toBe("X_APP_NOT_ENROLLED");
    expect(error?.message).toBe(X_APP_NOT_ENROLLED_MESSAGE);
    expect(error?.message).not.toContain("31885817");
  });

  it("a v2 402 says the X API credits ran out (X_CREDITS_EXHAUSTED)", async () => {
    stubX({ v2: () => json({ title: "CreditsDepleted" }, 402) });

    const error = await failure(ctx("image/jpeg"));

    expect(error?.code).toBe("X_CREDITS_EXHAUSTED");
    expect(error?.message).toBe(X_CREDITS_EXHAUSTED_MESSAGE);
  });

  it("image upload 429 -> RATE_LIMITED, not X_IMAGE_UPLOAD_FAILED", async () => {
    const fetchMock = stubX({ image: () => limited({ "Retry-After": "120" }) });

    const error = await failure(ctx("image/jpeg"));

    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.retryAt).toBeGreaterThan(Date.now());
    expect(fetchMock.mock.calls.some((c) => /statuses\/update|\/2\/tweets/.test(String(c[0])))).toBe(false);
  });

  it("video INIT 429 -> RATE_LIMITED, not X_VIDEO_INIT_FAILED", async () => {
    stubX({ init: () => limited() });
    expect((await failure(ctx("video/mp4")))?.code).toBe("RATE_LIMITED");
  });

  it("video APPEND 429 -> RATE_LIMITED, not X_VIDEO_APPEND_FAILED", async () => {
    stubX({ append: () => limited() });
    expect((await failure(ctx("video/mp4")))?.code).toBe("RATE_LIMITED");
  });

  it("video FINALIZE 429 -> RATE_LIMITED, not X_VIDEO_FINALIZE_FAILED", async () => {
    stubX({ finalize: () => limited() });
    expect((await failure(ctx("video/mp4")))?.code).toBe("RATE_LIMITED");
  });

  it("video STATUS 429 -> RATE_LIMITED, not X_VIDEO_STATUS_CHECK_FAILED", async () => {
    vi.useFakeTimers();
    stubX({
      finalize: () => json({ media_id_string: "m1", processing_info: { state: "pending", check_after_secs: 1 } }),
      status: () => limited(),
    });

    const promise = failure(ctx("video/mp4"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await promise)?.code).toBe("RATE_LIMITED");
  });

  it("a 429 is not retried in-step: the platform is called once", async () => {
    const fetchMock = stubX({ v2: () => limited() });

    await expect(
      withTransientRetries(() => xClient.publishVideo(ctx("image/jpeg")), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/2/tweets"))).toHaveLength(1);
  });

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): v1.1 statuses/update and
  // v2 POST /2/tweets are X's commit calls. Once media is uploaded, a 5xx /
  // timeout / dropped connection on either may already have posted, so it is
  // PUBLISH_UNCONFIRMED and v1.1 no longer falls back to v2 (it could post
  // twice). A v1.1 4xx/429 was rejected, so v2 is still tried; a v2 429 after
  // the media uploaded is RATE_LIMITED (the post waits), not unconfirmed.
  describe("commit calls (v1.1 statuses/update, v2 POST /2/tweets)", () => {
    /** A 2xx body that errors while it is being read (the connection drops mid-body). */
    const erroringBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      });
    const urlCalls = (fetchMock: ReturnType<typeof stubX>, fragment: string) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));
    const v1Calls = (fetchMock: ReturnType<typeof stubX>) => urlCalls(fetchMock, "statuses/update.json");
    const v2Calls = (fetchMock: ReturnType<typeof stubX>) => urlCalls(fetchMock, "/2/tweets");
    const mediaUploads = (fetchMock: ReturnType<typeof stubX>) => urlCalls(fetchMock, "upload.twitter.com");

    /** Make the stubbed fetch reject for one URL fragment (everything else keeps its route). */
    function stubXRejecting(fragment: string, error: unknown) {
      const inner = stubX({});
      const fetchMock = vi.fn<typeof fetch>((input, init) => {
        if (String(input).includes(fragment)) return Promise.reject(error);
        return inner(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("v1.1 502 -> PUBLISH_UNCONFIRMED, and v2 is NOT requested (v1.1 may already have posted)", async () => {
      const fetchMock = stubX({ v1: () => json({ errors: [] }, 502) });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(v1Calls(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it("v1.1 500 is not re-run by the in-step retry either", async () => {
      const fetchMock = stubX({ v1: () => json({ errors: [] }, 500) });

      await expect(
        withTransientRetries(() => xClient.publishVideo(ctx("image/jpeg")), { sleep: async () => {} }),
      ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
      expect(mediaUploads(fetchMock)).toHaveLength(1);
      expect(v1Calls(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it("v1.1 connection dropped after sending -> PUBLISH_UNCONFIRMED, v2 NOT requested", async () => {
      const fetchMock = stubXRejecting(
        "statuses/update.json",
        new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      );

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it("v1.1 timeout -> PUBLISH_UNCONFIRMED, v2 NOT requested", async () => {
      const timeout = Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" });
      const fetchMock = stubXRejecting("statuses/update.json", timeout);

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it("v1.1 never connected -> the same TypeError, rethrown (provably not sent)", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubXRejecting("statuses/update.json", neverConnected);

      expect(await failure(ctx("image/jpeg"))).toBe(neverConnected);
    });

    // Final review F4 (I2): a 2xx tweet create means the tweet may be live, so a
    // success body that cannot be read or parsed is PUBLISH_UNCONFIRMED (and v1.1
    // does not fall back to v2, which would post it again).
    it.each([
      ["invalid JSON", () => new Response("<html>ok</html>", { status: 200 })],
      ["a body that errors mid-read", () => new Response(erroringBody(), { status: 200 })],
    ] as const)("v1.1 2xx with %s -> PUBLISH_UNCONFIRMED, v2 NOT requested", async (_name, make) => {
      const fetchMock = stubX({ v1: make });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(v1Calls(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it.each([
      ["invalid JSON", () => new Response("<html>ok</html>", { status: 201 })],
      ["a body that errors mid-read", () => new Response(erroringBody(), { status: 201 })],
    ] as const)("v2 2xx with %s (after a v1.1 rejection) -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
      const fetchMock = stubX({ v1: () => json({ errors: [] }, 403), v2: make });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    // 2026-11-02 scale audit (jobs): a 2xx tweet create whose parsed body
    // lacks the id is PUBLISH_UNCONFIRMED (the platform said "created"), and v1.1
    // still does not fall back to v2.
    it.each([
      ["{}", () => json({}, 200)],
      ["an empty id_str", () => json({ id_str: "" }, 200)],
      ["a numeric id_str", () => json({ id_str: 5 }, 200)],
      ["a JSON null body", () => new Response("null", { status: 200 })],
    ] as const)("v1.1 2xx with %s (no id_str) -> PUBLISH_UNCONFIRMED, v2 NOT requested", async (_name, make) => {
      const fetchMock = stubX({ v1: make });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(v1Calls(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });

    it.each([
      ["{}", () => json({}, 201)],
      ["{ data: {} }", () => json({ data: {} }, 201)],
      ["{ data: null }", () => json({ data: null }, 201)],
      ["an empty data.id", () => json({ data: { id: "" } }, 201)],
      ["a JSON null body", () => new Response("null", { status: 201 })],
    ] as const)("v2 2xx with %s (no data.id, after a v1.1 rejection) -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
      const fetchMock = stubX({ v1: () => json({ errors: [] }, 403), v2: make });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    it("v1.1 2xx with an id_str succeeds with it", async () => {
      stubX({ v1: () => json({ id_str: "tweet-1" }, 200) });

      await expect(xClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({ externalPostId: "tweet-1" });
    });

    it("v1.1 403 -> falls back to v2 (unchanged)", async () => {
      const fetchMock = stubX({
        v1: () => json({ errors: [{ code: 187 }] }, 403),
        v2: () => json({ data: { id: "tweet-2", text: "x" } }, 201),
      });

      await expect(xClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({ externalPostId: "tweet-2" });
      expect(v1Calls(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    it("v1.1 429 -> falls back to v2 (unchanged)", async () => {
      const fetchMock = stubX({ v1: () => limited(), v2: () => json({ data: { id: "tweet-2", text: "x" } }, 201) });

      await expect(xClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({ externalPostId: "tweet-2" });
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    it("v2 502 after a v1.1 rejection -> PUBLISH_UNCONFIRMED, requested once", async () => {
      const fetchMock = stubX({ v1: () => json({ errors: [] }, 403), v2: () => json({}, 502) });

      const error = await failure(ctx("image/jpeg"));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    it("v2 timeout -> PUBLISH_UNCONFIRMED", async () => {
      const timeout = Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" });
      stubXRejecting("/2/tweets", timeout);

      expect((await failure(ctx("image/jpeg")))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("media uploaded, then v2 tweet 429 -> RATE_LIMITED (not unconfirmed)", async () => {
      const resetSec = Math.floor(Date.now() / 1000) + 900;
      const fetchMock = stubX({
        v1: () => json({ errors: [{ code: 88 }] }, 429),
        v2: () => limited({ "x-rate-limit-reset": String(resetSec) }),
      });

      const error = await failure(ctx("image/jpeg"));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: resetSec * 1000 });
      expect(error?.code).not.toBe("PUBLISH_UNCONFIRMED");
      expect(mediaUploads(fetchMock)).toHaveLength(1);
      expect(v2Calls(fetchMock)).toHaveLength(1);
    });

    it("a budget too small for the tweet -> PUBLISH_TIME_BUDGET_EXCEEDED before v1.1 is sent", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
      const start = Date.now();
      const fetchMock = stubX({
        // The media upload "takes" 60 s of the clock, leaving 3 s of a 63 s budget.
        image: () => {
          vi.setSystemTime(start + 60_000);
          return json({ media_id_string: "m1" });
        },
      });

      const error = await failure({ ...ctx("image/jpeg"), deadline: start + 63_000 });

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(v1Calls(fetchMock)).toHaveLength(0);
      expect(v2Calls(fetchMock)).toHaveLength(0);
    });
  });
});


// 2026-11-02 scale audit (jobs B3, M3): a video above 50 MiB on a platform listed in
// LARGE_UPLOAD_PLATFORMS is read from storage one 5 MiB segment at a time and sent across
// steps (the v1.1 shape the small path uses: base64 `media_data` in a signed form body), and
// X's processing of it is awaited across steps too. No real X endpoint, Blob or database is
// touched: every request goes through a stubbed global `fetch`, the upload state is an
// in-memory store and the clock is fake.
describe("xClient.publishVideo — streamed chunked upload (jobs B3, M3)", () => {
  // The vendor values and budgets as plain numbers, so these tests check the constants instead of
  // sharing them (the first test below pins each constant to its number).
  const SEG = 5_242_880;
  const PROCESSING_CAP_MS = 1_200_000;
  const EXPIRY_SAFETY_MS = 600_000;
  const DEFAULT_EXPIRES_SECS = 3_600;
  const RESUME_DELAY_MS = 30_000;
  const TWEET_WINDOW_MS = 30_000;
  const SEGMENTS = 12;
  /** 11 whole segments + 5 bytes: twelve segments, the last one tiny. */
  const TOTAL = 11 * SEG + 5;
  const NOW = Date.parse("2026-11-02T10:00:00.000Z");
  const STEP = PUBLISH_STEP_BUDGET_MS;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;

  // Recognisable credentials, so a leak into saved state, a log or an error is easy to find.
  const CREDENTIALS = {
    accessToken: "tok-AAA-111",
    accessTokenSecret: "sec-BBB-222",
    consumerKey: "ckey-CCC-333",
    consumerSecret: "csec-DDD-444",
  };

  type XError = Error & { code?: string; status?: number; retryAt?: number | null };
  type Call = Parameters<typeof fetch>;
  type Req = { url: string; init: RequestInit };
  type Reply = (req: Req) => Response | Promise<Response>;
  type Route = "init" | "append" | "finalize" | "status" | "v1" | "v2";

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  /** The byte the fake blob holds at absolute position `p`. */
  const byteAt = (p: number) => p % 251;

  const streams = { opened: 0, cancelled: 0 };

  /** Bytes `start..total-1` of the video, produced only when the reader asks (no read-ahead). */
  function lazyBlobBody(start: number, total: number) {
    let produced = 0;
    streams.opened += 1;
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
        cancel() {
          streams.cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
  }

  const reply =
    (status: number, body: string | null = null, headers: Record<string, string> = {}): Reply =>
    () =>
      new Response(body, { status, headers });
  const failWith =
    (error: unknown): Reply =>
    () =>
      Promise.reject(error);
  const timeoutFailure = () =>
    failWith(Object.assign(new Error("Request timed out after 120000ms"), { code: "FETCH_TIMEOUT" }));
  const connectionReset = () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
  const terminated = () => failWith(new TypeError("terminated"));
  const neverConnected = () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));

  /** The clock moves while a request is in flight. */
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const after =
    (ms: number, next: Reply): Reply =>
    (req) => {
      advance(ms);
      return next(req);
    };

  const initOk =
    (n = 1, extra: Record<string, unknown> = {}): Reply =>
    () =>
      json({ media_id_string: `m${n}`, ...extra });
  const appendOk: Reply = () => new Response(null, { status: 204 });
  /** After this segment the step has 50 s left: too little to start another one. */
  const lastSegmentOfTheStep = after(STEP - 50_000, appendOk);
  const finalizeDone: Reply = () => json({ media_id_string: "m1" });
  const processingInfo = (state: string, checkAfterSecs?: number) => ({
    state,
    ...(checkAfterSecs !== undefined ? { check_after_secs: checkAfterSecs } : {}),
  });
  const finalizeProcessing =
    (state = "pending", checkAfterSecs?: number): Reply =>
    () =>
      json({ media_id_string: "m1", processing_info: processingInfo(state, checkAfterSecs) });
  const statusInProgress =
    (checkAfterSecs?: number): Reply =>
    () =>
      json({ media_id_string: "m1", processing_info: { ...processingInfo("in_progress", checkAfterSecs), progress_percent: 40 } });
  const statusSucceeded: Reply = () => json({ media_id_string: "m1", processing_info: { state: "succeeded" } });
  const tweetV1: Reply = () => json({ id_str: "tweet-1" });
  const tweetV2: Reply = () => json({ data: { id: "tweet-2", text: "x" } }, 201);
  const limited = (resetSec?: number): Reply =>
    reply(429, "", resetSec === undefined ? {} : { "x-rate-limit-reset": String(resetSec) });

  const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
  const formOf = (call: Call | undefined) => (call?.[1] as RequestInit).body as URLSearchParams;

  /** The media command a request to the upload endpoint carries (INIT, APPEND, FINALIZE, STATUS). */
  const commandOf = (call: Call): string | null => {
    const url = String(call[0]);
    if (!url.includes("upload.twitter.com")) return null;
    const body = call[1]?.body;
    return body instanceof URLSearchParams ? body.get("command") : new URL(url).searchParams.get("command");
  };
  const labelOf = (call: Call): string => {
    const url = String(call[0]);
    if (url.includes("blob.example.com")) return "blob";
    if (url.includes("upload.twitter.com")) return commandOf(call) ?? "IMAGE";
    if (url.includes("statuses/update.json")) return "v1";
    if (url.includes("/2/tweets")) return "v2";
    return "?";
  };

  /**
   * Fakes the blob, the media endpoint and both tweet endpoints. Each route has a script of
   * answers (used in order); when it runs out, the route's default answers.
   */
  function stubX(
    opts: {
      total?: number;
      init?: Reply[];
      append?: Reply[];
      finalize?: Reply[];
      status?: Reply[];
      v1?: Reply[];
      v2?: Reply[];
      defaults?: Partial<Record<Route, Reply>>;
      blobStatus?: number;
      /** The blob answers after this long. */
      blobAdvance?: number;
      /** The blob's answer says it holds this many bytes. */
      blobClaimsTotal?: number;
      /** The blob request fails with this. */
      blobFailure?: unknown;
      /** The blob's body hands out a little, then fails with this (the connection dropped mid-body). */
      blobBodyFailure?: unknown;
    } = {},
  ) {
    const total = opts.total ?? TOTAL;
    const scripts: Record<Route, Reply[]> = {
      init: [...(opts.init ?? [])],
      append: [...(opts.append ?? [])],
      finalize: [...(opts.finalize ?? [])],
      status: [...(opts.status ?? [])],
      v1: [...(opts.v1 ?? [])],
      v2: [...(opts.v2 ?? [])],
    };
    let initsServed = 0;
    const fallback: Record<Route, Reply> = {
      init: (req) => initOk(++initsServed)(req),
      append: appendOk,
      finalize: finalizeDone,
      status: statusSucceeded,
      v1: tweetV1,
      v2: tweetV2,
      ...opts.defaults,
    };
    const next = (route: Route, req: Req) => (scripts[route].shift() ?? fallback[route])(req);

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const req = { url, init: init ?? {} };
      if (url.includes("blob.example.com")) {
        if (opts.blobAdvance !== undefined) advance(opts.blobAdvance);
        if (opts.blobFailure !== undefined) throw opts.blobFailure;
        if (opts.blobStatus !== undefined) return new Response(null, { status: opts.blobStatus });
        const range = /^bytes=(\d+)-$/.exec(headersOf(init)["Range"] ?? "");
        const start = range ? Number(range[1]) : 0;
        const claimed = opts.blobClaimsTotal ?? total;
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
            headers: { "Content-Range": `bytes ${start}-${claimed - 1}/${claimed}` },
          });
        }
        return range
          ? new Response(lazyBlobBody(start, total), {
              status: 206,
              headers: { "Content-Range": `bytes ${start}-${claimed - 1}/${claimed}` },
            })
          : new Response(lazyBlobBody(0, total), { status: 200, headers: { "Content-Length": String(claimed) } });
      }
      if (url.includes("upload.twitter.com")) {
        switch (commandOf([input, init])) {
          case "INIT":
            return next("init", req);
          case "APPEND":
            return next("append", req);
          case "FINALIZE":
            return next("finalize", req);
          case "STATUS":
            return next("status", req);
          default:
            return json({ media_id_string: "image-1" });
        }
      }
      if (url.includes("statuses/update.json")) return next("v1", req);
      if (url.includes("/2/tweets")) return next("v2", req);
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const where = (label: string) => fetchMock.mock.calls.filter((c) => labelOf(c) === label);
    return {
      fetchMock,
      /** Every request, in order, as a label: blob, INIT, APPEND, FINALIZE, STATUS, v1, v2. */
      sequence: () => fetchMock.mock.calls.map(labelOf),
      blobGets: () => where("blob"),
      inits: () => where("INIT"),
      appends: () => where("APPEND"),
      finalizes: () => where("FINALIZE"),
      statuses: () => where("STATUS"),
      v1Calls: () => where("v1"),
      v2Calls: () => where("v2"),
      tweets: () => [...where("v1"), ...where("v2")],
      /** When (in call order) the n-th request with this label was made. */
      orderOf: (label: string, nth = 0) => {
        let seen = 0;
        for (const [i, call] of fetchMock.mock.calls.entries()) {
          if (labelOf(call) !== label) continue;
          if (seen === nth) return fetchMock.mock.invocationCallOrder[i];
          seen += 1;
        }
        return Number.NaN;
      },
    };
  }

  type StateData = {
    mediaId: string;
    totalBytes: number;
    nextSegment: number;
    phase: "append" | "processing" | "ready";
    expiresAt: number;
    finalizedAt?: number;
    failedSegmentRetries: number;
  };

  /** An in-memory store with the real store's rules: a kind, and a readable `data` that holds no URL. */
  function fakeStore(initial?: { data: StateData }) {
    let current: { kind: string; data: unknown; secret?: unknown } | null = initial
      ? { kind: X_UPLOAD_STATE_KIND, ...structuredClone(initial) }
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
    return {
      store: mocks as unknown as UploadStateStore,
      mocks,
      /** What the store holds now. */
      saved: () => current,
      /** The `data` of every save, in order. */
      saves: () => mocks.save.mock.calls.map((c) => (c[1] as { data: StateData }).data),
    };
  }

  /** A saved upload that has `nextSegment` segments behind it, started at `NOW` (media m1, valid for an hour). */
  const appendState = (nextSegment: number, over: Partial<StateData> = {}) => ({
    data: {
      mediaId: "m1",
      totalBytes: TOTAL,
      nextSegment,
      phase: "append",
      expiresAt: NOW + HOUR,
      failedSegmentRetries: 0,
      ...over,
    } satisfies StateData,
  });
  /** Every segment is in, FINALIZE answered `finalizedAgoMs` ago, and X is still processing. */
  const processingState = (finalizedAgoMs = 0, over: Partial<StateData> = {}) =>
    appendState(SEGMENTS, { phase: "processing", finalizedAt: NOW - finalizedAgoMs, ...over });
  /** X finished processing: only the tweet is left. */
  const readyState = (over: Partial<StateData> = {}) =>
    appendState(SEGMENTS, { phase: "ready", finalizedAt: NOW - 120_000, ...over });

  function bigCtx(
    store: UploadStateStore | undefined,
    overrides: Partial<PublishContext> = {},
    sizeBytes = TOTAL,
    mimeType = "video/mp4",
  ): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-x",
        platform: "x",
        accessToken: CREDENTIALS.accessToken,
        refreshToken: CREDENTIALS.accessTokenSecret,
      } as unknown as SocialConnection,
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: {
        id: "media-1",
        mimeType,
        storageLocation: "https://blob.example.com/clip.mp4",
        sizeBytes,
        originalFilename: "clip.mp4",
      } as unknown as MediaItem,
      caption: "hello",
      uploadState: store,
      deadline: Date.now() + STEP,
      ...overrides,
    };
  }

  /**
   * Lets the code under test run to its end: whenever it is waiting on a timer (the processing
   * poll's wait) the fake clock jumps to it. Stops the moment the call settles, so `Date.now()`
   * afterwards is the instant it finished.
   */
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 5_000 && !settled; i += 1) await vi.advanceTimersToNextTimerAsync();
    return promise;
  }
  const run = (c: PublishContext) => drive(xClient.publishVideo(c));
  const failure = (c: PublishContext) =>
    drive(xClient.publishVideo(c)).then(
      () => null,
      (e: unknown) => e as XError,
    );
  const paused = (resumeAt: number | null = null) => ({ continuation: { resumeAt } });

  /** Every console call of the test (the logger writes through console), as one string. */
  const everythingLogged = () =>
    JSON.stringify(
      (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.mocked(console[level]).mock.calls),
    );
  const describeError = (error: unknown) => {
    const e = error as XError | null;
    return JSON.stringify({ name: e?.name, message: e?.message, stack: e?.stack, code: e?.code, status: e?.status, cause: String(e?.cause) });
  };
  function expectNoCredentials(...texts: string[]) {
    for (const text of texts) {
      for (const value of Object.values(CREDENTIALS)) expect(text).not.toContain(value);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("X_CONSUMER_KEY", CREDENTIALS.consumerKey);
    vi.stubEnv("X_CONSUMER_SECRET", CREDENTIALS.consumerSecret);
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "x");
    streams.opened = 0;
    streams.cancelled = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    // The stubbed fetch keeps every request it saw, and a segment's body is about 7 MB: let go of them.
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pins the vendor values, the budgets and the saved-state kind", () => {
    expect(X_APPEND_SEGMENT_BYTES).toBe(SEG);
    expect(X_UPLOAD_STATE_KIND).toBe("x_chunked");
    expect(X_LARGE_PROCESSING_MAX_MS).toBe(PROCESSING_CAP_MS);
    expect(X_MEDIA_EXPIRY_SAFETY_MS).toBe(EXPIRY_SAFETY_MS);
    expect(X_DEFAULT_MEDIA_EXPIRES_SECS).toBe(DEFAULT_EXPIRES_SECS);
    expect(X_TRANSIENT_RESUME_DELAY_MS).toBe(RESUME_DELAY_MS);
    expect(X_LARGE_STATUS_MIN_INTERVAL_MS).toBe(5_000);
    expect(X_LARGE_STATUS_MAX_INTERVAL_MS).toBe(60_000);
    expect(X_TWEET_MIN_WINDOW_MS).toBe(TWEET_WINDOW_MS);
    expect(X_TWEET_RESERVE_MS + 10_000).toBe(TWEET_WINDOW_MS);
    expect(TOTAL).toBeGreaterThan(LARGE_VIDEO_THRESHOLD_BYTES);
    expect(Math.ceil(TOTAL / SEG)).toBe(SEGMENTS);
  });

  describe("which path a post takes", () => {
    it("keeps today's whole-file download when X is not enabled (the default)", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "");
      const { store, mocks } = fakeStore();
      const x = stubX({ total: 4 });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(x.sequence()).toEqual(["blob", "INIT", "APPEND", "FINALIZE", "v1"]);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBeUndefined();
    });

    it("keeps today's path, request for request, for a video at or below 50 MiB and for a direct caller with no store", async () => {
      const { store, mocks } = fakeStore();
      const x = stubX({ total: 4 });

      await run(bigCtx(store, {}, LARGE_VIDEO_THRESHOLD_BYTES));
      await run(bigCtx(undefined));

      const today = ["blob", "INIT", "APPEND", "FINALIZE", "v1"];
      expect(x.sequence()).toEqual([...today, ...today]);
      expect(mocks.save).not.toHaveBeenCalled();
      for (const call of x.blobGets()) expect(headersOf(call[1])["Range"]).toBeUndefined();
      expect(Object.fromEntries(formOf(x.inits()[0]))).toEqual({
        command: "INIT",
        total_bytes: "4",
        media_type: "video/mp4",
        media_category: "tweet_video",
      });
    });

    it("takes the streamed path for a video above 50 MiB when X is enabled: a Range read, never a whole download", async () => {
      const { store } = fakeStore();
      const x = stubX({ append: [lastSegmentOfTheStep] });

      await run(bigCtx(store));

      expect(x.sequence()).toEqual(["INIT", "blob", "APPEND"]);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBe("bytes=0-");
    });

    it("an upload that already has saved state stays on the streamed path even after the switch is turned off", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "none");
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX();

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["blob", "APPEND", "FINALIZE", "v1"]);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBe(`bytes=${(SEGMENTS - 1) * SEG}-`);
    });

    it("another platform's switch does not enable X", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "youtube,tiktok,linkedin");
      const { store, mocks } = fakeStore();
      const x = stubX({ total: 4 });

      await run(bigCtx(store));

      expect(mocks.save).not.toHaveBeenCalled();
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBeUndefined();
    });

    it("an image never takes the chunked path, whatever its size", async () => {
      const { store, mocks } = fakeStore();
      const x = stubX({ total: 4 });

      const result = await run(bigCtx(store, {}, TOTAL, "image/jpeg"));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["blob", "IMAGE", "v1"]);
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });

  describe("the first step", () => {
    it("runs INIT once with the video's size, and saves the upload before the first APPEND", async () => {
      const { store, mocks } = fakeStore();
      const x = stubX({ append: [lastSegmentOfTheStep] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused());
      expect(x.inits()).toHaveLength(1);
      expect(Object.fromEntries(formOf(x.inits()[0]))).toEqual({
        command: "INIT",
        total_bytes: String(TOTAL),
        media_type: "video/mp4",
        media_category: "tweet_video",
      });
      const [firstSave] = mocks.save.mock.calls;
      expect(firstSave[0]).toBe(X_UPLOAD_STATE_KIND);
      expect(firstSave[1]).toEqual({
        data: {
          mediaId: "m1",
          totalBytes: TOTAL,
          nextSegment: 0,
          phase: "append",
          expiresAt: NOW + DEFAULT_EXPIRES_SECS * 1000,
          failedSegmentRetries: 0,
        },
      });
      expect(mocks.save.mock.invocationCallOrder[0]).toBeGreaterThan(x.orderOf("INIT"));
      expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(x.orderOf("APPEND"));
    });

    it.each([
      ["86,400 s", 86_400, 86_400],
      ["7,200 s", 7_200, 7_200],
      ["nothing", undefined, DEFAULT_EXPIRES_SECS],
      ["zero", 0, DEFAULT_EXPIRES_SECS],
      ["a negative number", -5, DEFAULT_EXPIRES_SECS],
      ["text", "soon", DEFAULT_EXPIRES_SECS],
      ["null", null, DEFAULT_EXPIRES_SECS],
    ] as const)("records expiresAt from expires_after_secs: INIT says %s", async (_name, said, expected) => {
      const { store, mocks } = fakeStore();
      stubX({ init: [initOk(1, { expires_after_secs: said })], append: [lastSegmentOfTheStep] });

      await run(bigCtx(store));

      expect(mocks.save.mock.calls[0][1]).toMatchObject({ data: { expiresAt: NOW + expected * 1000 } });
    });

    it("sends each segment as today's signed form body: command, media_id, segment_index and base64 media_data, signed afresh", async () => {
      const { store } = fakeStore(appendState(SEGMENTS - 3));
      const x = stubX();

      await run(bigCtx(store));

      const appends = x.appends();
      expect(appends).toHaveLength(3);
      const nonces = new Set<string>();
      appends.forEach((call, i) => {
        const index = SEGMENTS - 3 + i;
        const headers = headersOf(call[1]);
        expect(call[1]?.method).toBe("POST");
        expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
        expect(headers["Authorization"]).toMatch(/^OAuth /);
        expect(headers["Authorization"]).toContain("oauth_signature=");
        nonces.add(/oauth_nonce="([^"]+)"/.exec(headers["Authorization"])![1]);

        const form = formOf(call);
        expect([...form.keys()]).toEqual(["command", "media_id", "segment_index", "media_data"]);
        expect(form.get("media_id")).toBe("m1");
        expect(form.get("segment_index")).toBe(String(index));
        const bytes = Buffer.from(form.get("media_data")!, "base64");
        const first = index * SEG;
        expect(bytes.length).toBe(index === SEGMENTS - 1 ? 5 : SEG);
        for (const at of [0, 1, Math.floor(bytes.length / 2), bytes.length - 1]) {
          expect(bytes[at]).toBe(byteAt(first + at));
        }
      });
      expect(nonces.size).toBe(3);
    });

    it("a 12-segment video over two steps: INIT once, segment_index 0-11 with no gap or repeat, every segment at most 5 MiB, FINALIZE once", async () => {
      const { store } = fakeStore();
      const stepOne = stubX({ defaults: { append: after(20_000, appendOk) } });
      const first = await run(bigCtx(store));
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW + 10 * MINUTE);
      const stepTwo = stubX();
      const second = await run(bigCtx(store, { continuation: 1 }));

      // 225 s of budget, 20 s per segment, 60 s needed to start one: segments 0-8 fit.
      expect(first).toEqual(paused());
      expect(second).toEqual({ externalPostId: "tweet-1" });
      expect(stepOne.inits()).toHaveLength(1);
      expect(stepTwo.inits()).toHaveLength(0);

      const all = [...stepOne.appends(), ...stepTwo.appends()];
      expect(all.map((c) => Number(formOf(c).get("segment_index")))).toEqual(
        Array.from({ length: SEGMENTS }, (_, i) => i),
      );
      let received = 0;
      for (const call of all) {
        const bytes = Buffer.from(formOf(call).get("media_data")!, "base64");
        expect(bytes.length).toBeLessThanOrEqual(5_242_880);
        expect(bytes[0]).toBe(byteAt(received));
        expect(bytes[bytes.length - 1]).toBe(byteAt(received + bytes.length - 1));
        received += bytes.length;
      }
      expect(received).toBe(TOTAL);
      expect(stepOne.finalizes()).toHaveLength(0);
      expect(stepTwo.finalizes()).toHaveLength(1);
      expect(stepOne.tweets()).toHaveLength(0);
      expect(stepTwo.tweets()).toHaveLength(1);
    });

    it("reads the blob with one Range request per step and closes it, never a whole download", async () => {
      const { store } = fakeStore();
      const stepOne = stubX({ append: [lastSegmentOfTheStep] });
      await run(bigCtx(store));
      const afterFirst = { opened: streams.opened, cancelled: streams.cancelled };
      vi.unstubAllGlobals();
      const stepTwo = stubX({ append: [lastSegmentOfTheStep] });
      await run(bigCtx(store));

      expect(stepOne.blobGets()).toHaveLength(1);
      expect(headersOf(stepOne.blobGets()[0][1])["Range"]).toBe("bytes=0-");
      expect(afterFirst).toEqual({ opened: 1, cancelled: 1 });
      expect(stepTwo.blobGets()).toHaveLength(1);
      expect(headersOf(stepTwo.blobGets()[0][1])["Range"]).toBe(`bytes=${SEG}-`);
      expect(streams).toEqual({ opened: 2, cancelled: 2 });
    });
  });

  describe("across steps", () => {
    it.each([
      ["continuation 0", { continuation: 0 }],
      ["continuation 3", { continuation: 3 }],
      ["no continuation number", {}],
    ] as const)("resumes from the saved state alone (%s): no INIT, the blob read starts at the next segment", async (_name, over) => {
      const { store } = fakeStore(appendState(SEGMENTS - 2));
      const x = stubX();

      const result = await run(bigCtx(store, over));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.inits()).toHaveLength(0);
      expect(x.appends().map((c) => formOf(c).get("segment_index"))).toEqual([String(SEGMENTS - 2), String(SEGMENTS - 1)]);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBe(`bytes=${(SEGMENTS - 2) * SEG}-`);
    });

    it("starts a new upload when there is no saved state, whatever the continuation number says", async () => {
      const { store } = fakeStore();
      const x = stubX({ append: [lastSegmentOfTheStep] });

      await run(bigCtx(store, { continuation: 3 }));

      expect(x.inits()).toHaveLength(1);
    });

    it("saved state of another size is ignored with a warning and a new upload starts", async () => {
      const { store } = fakeStore(appendState(5, { totalBytes: TOTAL - 1 }));
      const x = stubX({ append: [lastSegmentOfTheStep] });

      await run(bigCtx(store));

      expect(x.inits()).toHaveLength(1);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBe("bytes=0-");
      expect(vi.mocked(console.warn)).toHaveBeenCalled();
    });

    it.each([
      ["a missing media id", { mediaId: "" }],
      ["a negative segment", { nextSegment: -1 }],
      ["a segment past the end", { nextSegment: SEGMENTS + 1 }],
      ["a fractional segment", { nextSegment: 2.5 }],
      ["an unknown phase", { phase: "bogus" as unknown as "append" }],
      ["an expiry that is not a number", { expiresAt: "soon" as unknown as number }],
      ["a negative retry count", { failedSegmentRetries: -1 }],
      ["a processing phase with segments missing", { phase: "processing" as const, nextSegment: 5, finalizedAt: NOW }],
      ["a processing phase with no FINALIZE time", { phase: "processing" as const, nextSegment: SEGMENTS }],
    ] as const)("saved state with %s cannot be used: a new upload starts", async (_name, over) => {
      const { store } = fakeStore(appendState(4, over as Partial<StateData>));
      const x = stubX({ append: [lastSegmentOfTheStep] });

      await run(bigCtx(store));

      expect(x.inits()).toHaveLength(1);
      expect(x.appends().map((c) => formOf(c).get("segment_index"))).toEqual(["0"]);
    });
  });

  describe("FINALIZE and the wait for processing", () => {
    it.each([
      ["1 s", 1, 5_000],
      ["10 s", 10, 10_000],
      ["600 s", 600, 60_000],
      ["nothing", undefined, 5_000],
    ] as const)("check_after_secs %s: waits in the step, polls, then tweets once in the same step", async (_name, checkAfter, waitMs) => {
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX({ finalize: [finalizeProcessing("pending", checkAfter)], status: [statusSucceeded] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(Date.now() - NOW).toBe(waitMs);
      expect(x.sequence()).toEqual(["blob", "APPEND", "FINALIZE", "STATUS", "v1"]);
    });

    it("FINALIZE and STATUS are signed requests to the media endpoint for the same media id", async () => {
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX({ finalize: [finalizeProcessing("pending", 5)] });

      await run(bigCtx(store));

      expect(Object.fromEntries(formOf(x.finalizes()[0]))).toEqual({ command: "FINALIZE", media_id: "m1" });
      const [statusUrl, statusInit] = x.statuses()[0];
      expect(String(statusUrl)).toBe("https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=m1");
      expect(statusInit?.method).toBe("GET");
      expect(headersOf(statusInit)["Authorization"]).toMatch(/^OAuth .*oauth_signature=/);
    });

    it("saves the processing phase right after FINALIZE, with the time FINALIZE answered", async () => {
      const { store, saves } = fakeStore(appendState(SEGMENTS - 1, { failedSegmentRetries: 1 }));
      stubX({ finalize: [after(7_000, finalizeProcessing("pending", 5))], status: [statusSucceeded] });

      await run(bigCtx(store));

      expect(saves()).toContainEqual({
        mediaId: "m1",
        totalBytes: TOTAL,
        nextSegment: SEGMENTS,
        phase: "processing",
        expiresAt: NOW + HOUR,
        finalizedAt: NOW + 7_000,
        failedSegmentRetries: 0,
      });
    });

    it.each([
      ["a 1 s hint", 1, 5_000],
      ["a 10 s hint", 10, 10_000],
      ["a 600 s hint", 600, 60_000],
    ] as const)("processing still running when the step ends (%s): saves and continues at now + the clamped hint, with no tweet", async (_name, checkAfter, waitMs) => {
      const { store, saves } = fakeStore(appendState(SEGMENTS - 1));
      // After FINALIZE the step has 30 s left: not enough for a wait, a check and the tweet reserve.
      const x = stubX({ finalize: [after(STEP - 30_000, finalizeProcessing("in_progress", checkAfter))] });

      const result = await run(bigCtx(store));

      const finalizedAt = NOW + STEP - 30_000;
      expect(result).toEqual(paused(finalizedAt + waitMs));
      expect(saves().at(-1)).toMatchObject({ phase: "processing", nextSegment: SEGMENTS, finalizedAt });
      expect(x.statuses()).toHaveLength(0);
      expect(x.tweets()).toHaveLength(0);
    });

    it("the next call polls straight away without APPEND, FINALIZE or a blob read, then tweets once", async () => {
      const { store } = fakeStore(processingState(60_000));
      const x = stubX({ status: [statusSucceeded] });

      const result = await run(bigCtx(store, { continuation: 2 }));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["STATUS", "v1"]);
      expect(Date.now()).toBe(NOW);
    });

    it("keeps waiting and polling while the step has room for a wait, a check and the tweet reserve, then continues", async () => {
      const { store } = fakeStore(processingState(30_000));
      const x = stubX({ defaults: { status: statusInProgress(30) } });

      const result = (await run(bigCtx(store))) as { continuation: { resumeAt: number } };

      expect(x.statuses().length).toBeGreaterThanOrEqual(3);
      expect(Date.now() - NOW).toBeLessThanOrEqual(STEP - X_TWEET_RESERVE_MS);
      expect(result).toEqual(paused(Date.now() + 30_000));
      expect(x.tweets()).toHaveLength(0);
      expect(x.appends()).toHaveLength(0);
      expect(x.finalizes()).toHaveLength(0);
    });

    it("a poll that succeeds with at least the tweet window left tweets in the same step; with less it saves `ready` and continues at once", async () => {
      const enough = fakeStore(processingState(30_000));
      const enoughX = stubX({ status: [after(STEP - TWEET_WINDOW_MS, statusSucceeded)] });
      const tweeted = await run(bigCtx(enough.store));
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW);

      const short = fakeStore(processingState(30_000));
      const shortX = stubX({ status: [after(STEP - TWEET_WINDOW_MS + 1, statusSucceeded)] });
      const deferred = await run(bigCtx(short.store));

      expect(tweeted).toEqual({ externalPostId: "tweet-1" });
      expect(enoughX.tweets()).toHaveLength(1);
      expect(deferred).toEqual(paused());
      expect(shortX.tweets()).toHaveLength(0);
      expect(short.saves().at(-1)).toMatchObject({ phase: "ready", mediaId: "m1" });
    });

    it("the call after that sends only the tweet", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX();

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["v1"]);
    });

    it("FINALIZE with no processing_info means ready: the tweet follows in the same step", async () => {
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX();

      await run(bigCtx(store));

      expect(x.sequence()).toEqual(["blob", "APPEND", "FINALIZE", "v1"]);
    });

    it("a STATUS answer with no processing_info means ready", async () => {
      const { store } = fakeStore(processingState());
      const x = stubX({ status: [() => json({ media_id_string: "m1" })] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["STATUS", "v1"]);
    });

    it("a state it does not know is still processing: nothing is tweeted until X says succeeded", async () => {
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX({
        finalize: [finalizeProcessing("queued", 5)],
        status: [statusInProgress(5), statusSucceeded],
      });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["blob", "APPEND", "FINALIZE", "STATUS", "STATUS", "v1"]);
    });

    it.each([
      ["FINALIZE says failed", () => ({ finalize: [finalizeProcessing("failed", 5)] }), appendState(SEGMENTS - 1)],
      ["STATUS says failed", () => ({ status: [() => json({ processing_info: { state: "failed" } })] }), processingState()],
      [
        "STATUS carries an error",
        () => ({ status: [() => json({ processing_info: { state: "in_progress", error: { code: 1, message: "UPSTREAM-DETAIL" } } })] }),
        processingState(),
      ],
    ] as const)("%s: X_VIDEO_PROCESSING_FAILED with no tweet and none of X's text", async (_name, routes, state) => {
      const { store } = fakeStore(state);
      const x = stubX(routes());

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("X_VIDEO_PROCESSING_FAILED");
      expect(error?.message).not.toContain("UPSTREAM-DETAIL");
      expect(x.tweets()).toHaveLength(0);
    });
  });

  describe("processing that takes too long", () => {
    it("still in_progress 20 minutes after FINALIZE, across steps: X_VIDEO_PROCESSING_TIMEOUT and no tweet", async () => {
      const { store, saves } = fakeStore(appendState(SEGMENTS - 1));
      const stepOne = stubX({ finalize: [after(STEP - 30_000, finalizeProcessing("pending", 10))] });
      const first = await run(bigCtx(store));
      const finalizedAt = saves().at(-1)!.finalizedAt!;
      vi.unstubAllGlobals();
      vi.setSystemTime(finalizedAt + PROCESSING_CAP_MS + 1_000);
      const stepTwo = stubX({ defaults: { status: statusInProgress(10) } });

      const error = await failure(bigCtx(store, { continuation: 1 }));

      expect(first).toEqual(paused(finalizedAt + 10_000));
      expect(error?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
      expect(error?.message).toMatch(/still processing/i);
      expect(stepOne.tweets()).toHaveLength(0);
      expect(stepTwo.tweets()).toHaveLength(0);
      expect(stepTwo.finalizes()).toHaveLength(0);
    });

    it("exactly 20 minutes counts as too long", async () => {
      const { store } = fakeStore(processingState(PROCESSING_CAP_MS));
      const x = stubX({ defaults: { status: statusInProgress(5) } });

      expect((await failure(bigCtx(store)))?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
      expect(x.tweets()).toHaveLength(0);
    });

    it("the cap also ends the in-step polling: 10 s short of it, the third poll is the last", async () => {
      const { store } = fakeStore(processingState(PROCESSING_CAP_MS - 10_000));
      const x = stubX({ defaults: { status: statusInProgress(5) } });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
      expect(x.statuses()).toHaveLength(3);
      expect(Date.now() - NOW).toBe(10_000);
    });

    it("a video that finished processing is tweeted even when the poll finds out after the cap", async () => {
      const { store } = fakeStore(processingState(PROCESSING_CAP_MS + 5 * MINUTE));
      const x = stubX({ status: [statusSucceeded] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "tweet-1" });
      expect(x.tweets()).toHaveLength(1);
    });
  });

  describe("a STATUS check that gets no usable answer", () => {
    it.each([
      ["a 503", reply(503)],
      ["a 500", reply(500, "oops")],
      ["a timeout", timeoutFailure()],
      ["a dropped connection", connectionReset()],
      ["a terminated body", terminated()],
    ] as const)("%s: saves and continues 30 s later, without failing the upload", async (_name, answer) => {
      const { store, saves } = fakeStore(processingState(60_000));
      const x = stubX({ status: [answer] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY_MS));
      expect(saves().at(-1)).toMatchObject({ phase: "processing", mediaId: "m1" });
      expect(x.tweets()).toHaveLength(0);
    });

    it("an answer whose body drops while it is read is the same: saved, and asked again later", async () => {
      const { store } = fakeStore(processingState(60_000));
      const droppingBody = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        );
      stubX({ status: [droppingBody] });

      expect(await run(bigCtx(store))).toEqual(paused(NOW + RESUME_DELAY_MS));
    });

    it("an answer that is not JSON is X_VIDEO_STATUS_CHECK_FAILED, with none of its text", async () => {
      const { store } = fakeStore(processingState(60_000));
      stubX({ status: [() => new Response("<html>UPSTREAM-DETAIL</html>", { status: 200 })] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("X_VIDEO_STATUS_CHECK_FAILED");
      expect(error?.message).not.toContain("UPSTREAM-DETAIL");
    });

    it("keeps trying only until the processing cap", async () => {
      const { store } = fakeStore(processingState(PROCESSING_CAP_MS + 1_000));
      stubX({ status: [reply(503)] });

      expect((await failure(bigCtx(store)))?.code).toBe("X_VIDEO_PROCESSING_TIMEOUT");
    });

    it("a TypeError that is not a network failure is a bug, not a transient: it is rethrown", async () => {
      const { store } = fakeStore(processingState(60_000));
      const bug = new TypeError("Cannot read properties of undefined (reading 'state')");
      stubX({ status: [failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
    });

    it("a 4xx is X_VIDEO_STATUS_CHECK_FAILED", async () => {
      const { store } = fakeStore(processingState(60_000));
      stubX({ status: [reply(400, "bad media id")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "X_VIDEO_STATUS_CHECK_FAILED", status: 400 });
    });

    it("a 429 saves the position, then throws RATE_LIMITED with X's reset time", async () => {
      const resetSec = Math.floor(NOW / 1000) + 600;
      const { store, mocks, saved } = fakeStore(processingState(60_000));
      const x = stubX({ status: [limited(resetSec)] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: resetSec * 1000 });
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(saved()?.data).toMatchObject({ phase: "processing", mediaId: "m1", nextSegment: SEGMENTS });
      expect(x.tweets()).toHaveLength(0);
    });
  });

  describe("media that is about to expire", () => {
    it("is dropped and uploaded again from INIT: clear(), a new media id, APPEND from segment 0 (nothing was tweeted)", async () => {
      const { store, mocks, saves } = fakeStore(readyState({ expiresAt: NOW + 5 * MINUTE }));
      const x = stubX({ init: [initOk(2)], append: [lastSegmentOfTheStep] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused());
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(mocks.clear.mock.invocationCallOrder[0]).toBeLessThan(x.orderOf("INIT"));
      expect(x.sequence()).toEqual(["INIT", "blob", "APPEND"]);
      expect(headersOf(x.blobGets()[0][1])["Range"]).toBe("bytes=0-");
      expect(Object.fromEntries(formOf(x.appends()[0]))).toMatchObject({ media_id: "m2", segment_index: "0" });
      expect(saves()[0]).toMatchObject({ mediaId: "m2", nextSegment: 0, phase: "append" });
      expect(saves().at(-1)).toMatchObject({ mediaId: "m2", nextSegment: 1 });
    });

    it("a 429 on the INIT that replaces expired media leaves no stale state behind: the deferred step starts over", async () => {
      const { store, mocks, saved } = fakeStore(readyState({ expiresAt: NOW + 5 * MINUTE }));
      stubX({ init: [limited()] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(mocks.save).not.toHaveBeenCalled();
      expect(saved()).toBeNull();
    });

    it("the new media's own expiry is not checked again in the same step: no loop", async () => {
      const { store } = fakeStore(readyState({ expiresAt: NOW + 5 * MINUTE }));
      const x = stubX({ init: [initOk(2, { expires_after_secs: 300 })], append: [lastSegmentOfTheStep] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused());
      expect(x.inits()).toHaveLength(1);
      expect(x.appends()).toHaveLength(1);
    });

    it("a media id created in this very step is tweeted even if its lifetime is under the safety margin: no endless re-INIT", async () => {
      const { store } = fakeStore();
      const x = stubX({ init: [initOk(1, { expires_after_secs: 300 })] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.inits()).toHaveLength(1);
      expect(x.appends()).toHaveLength(SEGMENTS);
      expect(x.v1Calls()).toHaveLength(1);
    });

    it.each([
      ["while segments are still being sent", () => appendState(5, { expiresAt: NOW + 5 * MINUTE })],
      ["while X is processing it", () => processingState(30_000, { expiresAt: NOW + 5 * MINUTE })],
      ["before the tweet", () => readyState({ expiresAt: NOW + 5 * MINUTE })],
    ] as const)("%s: starts over from INIT", async (_name, state) => {
      const { store, mocks } = fakeStore(state());
      const x = stubX({ init: [initOk(2)], append: [lastSegmentOfTheStep] });

      await run(bigCtx(store));

      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(x.inits()).toHaveLength(1);
      expect(x.statuses()).toHaveLength(0);
      expect(x.tweets()).toHaveLength(0);
      expect(formOf(x.appends()[0]).get("segment_index")).toBe("0");
    });

    it("exactly the safety margin left is still usable; one millisecond less is not", async () => {
      const usable = fakeStore(readyState({ expiresAt: NOW + EXPIRY_SAFETY_MS }));
      const usableX = stubX();
      const tweeted = await run(bigCtx(usable.store));
      vi.unstubAllGlobals();

      const expiring = fakeStore(readyState({ expiresAt: NOW + EXPIRY_SAFETY_MS - 1 }));
      const expiringX = stubX({ append: [lastSegmentOfTheStep] });
      await run(bigCtx(expiring.store));

      expect(tweeted).toEqual({ externalPostId: "tweet-1" });
      expect(usable.mocks.clear).not.toHaveBeenCalled();
      expect(usableX.inits()).toHaveLength(0);
      expect(expiring.mocks.clear).toHaveBeenCalledTimes(1);
      expect(expiringX.inits()).toHaveLength(1);
    });
  });

  describe("a segment that fails", () => {
    const unanswered = [
      ["a 503", () => reply(503)],
      ["a 502", () => reply(502, "bad gateway")],
      ["a timeout", () => timeoutFailure()],
      ["a dropped connection", () => connectionReset()],
      ["a refused connection", () => neverConnected()],
      ["a terminated body", () => terminated()],
    ] as const;

    it.each(unanswered)("%s: the segment is retried once in the next step (failedSegmentRetries 1, resume in 30 s)", async (_name, answer) => {
      const { store, saves } = fakeStore(appendState(10));
      const x = stubX({ append: [answer()] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY_MS));
      expect(saves().at(-1)).toEqual({ ...appendState(10).data, failedSegmentRetries: 1 });
      expect(x.sequence()).toEqual(["blob", "APPEND"]);
    });

    it.each(unanswered)("%s a second time: X_VIDEO_APPEND_FAILED", async (_name, answer) => {
      const { store } = fakeStore(appendState(10, { failedSegmentRetries: 1 }));
      const x = stubX({ append: [answer()] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("X_VIDEO_APPEND_FAILED");
      expect(error?.message).toMatch(/segment 10/);
      expect(x.appends()).toHaveLength(1);
      expect(x.finalizes()).toHaveLength(0);
      expect(x.tweets()).toHaveLength(0);
    });

    it("the exhausted error carries no status, so the in-step retry does not send the segment again", async () => {
      const { store } = fakeStore(appendState(10, { failedSegmentRetries: 1 }));
      const x = stubX({ defaults: { append: reply(503) } });

      await expect(
        withTransientRetries(() => xClient.publishVideo(bigCtx(store)), { sleep: async () => {} }),
      ).rejects.toMatchObject({ code: "X_VIDEO_APPEND_FAILED" });
      expect(x.appends()).toHaveLength(1);
    });

    it("a segment that goes through after a failure resets the count and the upload carries on", async () => {
      const { store, saves } = fakeStore(appendState(10, { failedSegmentRetries: 1 }));
      const x = stubX();

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.appends().map((c) => formOf(c).get("segment_index"))).toEqual(["10", "11"]);
      expect(saves()[0]).toMatchObject({ nextSegment: 11, failedSegmentRetries: 0 });
    });

    it("a failure of the next segment starts its own count", async () => {
      const { store, saves } = fakeStore(appendState(10, { failedSegmentRetries: 1 }));
      stubX({ append: [appendOk, reply(503)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY_MS));
      expect(saves().at(-1)).toMatchObject({ nextSegment: 11, failedSegmentRetries: 1 });
    });

    it("a 400 is X_VIDEO_APPEND_FAILED at once, with its status", async () => {
      const { store, mocks } = fakeStore(appendState(10));
      stubX({ append: [reply(400, "bad segment")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "X_VIDEO_APPEND_FAILED", status: 400 });
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a TypeError that is not a network failure is a bug, not a transient: it is rethrown, not retried", async () => {
      const { store, mocks } = fakeStore(appendState(10));
      const bug = new TypeError("Cannot read properties of undefined (reading 'length')");
      stubX({ append: [failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a 429 saves the position, then throws RATE_LIMITED with X's reset time", async () => {
      const resetSec = Math.floor(NOW / 1000) + 900;
      const { store, mocks, saved } = fakeStore(appendState(10));
      stubX({ append: [limited(resetSec)] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: resetSec * 1000 });
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(saved()?.data).toEqual(appendState(10).data);
    });

    describe("running into the step deadline", () => {
      it("a segment that times out at the deadline pauses without counting a failure", async () => {
        const { store, saves } = fakeStore(appendState(10));
        stubX({ append: [after(STEP - 30_000, timeoutFailure())] });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused());
        expect(saves().at(-1)).toEqual(appendState(10).data);
      });

      it("a request the budget has no room for (PUBLISH_TIME_BUDGET_EXCEEDED) pauses instead of failing", async () => {
        const { store, saves } = fakeStore(appendState(10));
        const noRoom = Object.assign(new Error("Publishing ran out of time before it finished."), {
          code: PUBLISH_BUDGET_EXCEEDED_CODE,
        });
        stubX({ append: [after(STEP - 3_000, failWith(noRoom))] });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused());
        expect(saves().at(-1)).toEqual(appendState(10).data);
      });

      it("reading the blob runs out the clock: the segment is not sent and nothing fails", async () => {
        const { store, saves } = fakeStore(appendState(10));
        const x = stubX({ blobAdvance: STEP - 3_000 });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused());
        expect(x.appends()).toHaveLength(0);
        expect(saves().at(-1)).toEqual(appendState(10).data);
      });

      it("after reading, a segment is sent with exactly 60 s left but not with one millisecond less", async () => {
        const exact = fakeStore(appendState(10));
        const exactX = stubX({ blobAdvance: STEP - LARGE_UPLOAD_CHUNK_WINDOW_MS, append: [lastSegmentOfTheStep] });
        await run(bigCtx(exact.store));
        vi.unstubAllGlobals();
        vi.setSystemTime(NOW);

        const short = fakeStore(appendState(10));
        const shortX = stubX({ blobAdvance: STEP - LARGE_UPLOAD_CHUNK_WINDOW_MS + 1 });
        await run(bigCtx(short.store));

        expect(exactX.appends()).toHaveLength(1);
        expect(shortX.appends()).toHaveLength(0);
      });

      it("a blob request that fails at the deadline pauses; with time to spare it is the error", async () => {
        const timeoutError = Object.assign(new Error("Request timed out after 225000ms"), { code: "FETCH_TIMEOUT" });
        const late = fakeStore(appendState(10));
        stubX({ blobAdvance: STEP - 10_000, blobFailure: timeoutError });
        const pausedResult = await run(bigCtx(late.store));
        vi.unstubAllGlobals();
        vi.setSystemTime(NOW);

        const early = fakeStore(appendState(10));
        stubX({ blobFailure: timeoutError });
        const thrown = await failure(bigCtx(early.store));

        expect(pausedResult).toEqual(paused());
        expect(thrown).toBe(timeoutError);
      });

      it("a 503 that arrives with the budget nearly spent still counts as the segment's failure", async () => {
        const { store, saves } = fakeStore(appendState(10));
        stubX({ append: [after(STEP - 30_000, reply(503))] });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused(Date.now() + RESUME_DELAY_MS));
        expect(saves().at(-1)).toMatchObject({ failedSegmentRetries: 1 });
      });

      it("every segment waits for a full window: with less than 60 s left nothing is sent", async () => {
        const { store, saves } = fakeStore(appendState(10));
        const x = stubX();

        const result = await run(bigCtx(store, { deadline: Date.now() + LARGE_UPLOAD_CHUNK_WINDOW_MS - 1 }));

        expect(result).toEqual(paused());
        expect(x.sequence()).toEqual([]);
        expect(saves().at(-1)).toEqual(appendState(10).data);
      });
    });
  });

  describe("INIT and FINALIZE failures", () => {
    it("with all segments in and under 60 s left, FINALIZE waits for the next step and no blob is opened", async () => {
      const { store, saves } = fakeStore(appendState(SEGMENTS));
      const x = stubX();

      const result = await run(bigCtx(store, { deadline: Date.now() + LARGE_UPLOAD_CHUNK_WINDOW_MS - 1 }));

      expect(result).toEqual(paused());
      expect(x.sequence()).toEqual([]);
      expect(saves().at(-1)).toEqual(appendState(SEGMENTS).data);
    });

    it("with exactly 60 s left FINALIZE is sent", async () => {
      const { store } = fakeStore(appendState(SEGMENTS));
      const x = stubX({ finalize: [finalizeProcessing("pending", 5)], status: [statusInProgress(5)] });

      await run(bigCtx(store, { deadline: Date.now() + LARGE_UPLOAD_CHUNK_WINDOW_MS }));

      expect(x.finalizes()).toHaveLength(1);
      expect(x.appends()).toHaveLength(0);
    });

    it.each([
      ["a 503", () => reply(503)],
      ["a timeout", () => timeoutFailure()],
      ["a dropped connection", () => connectionReset()],
    ] as const)("%s on FINALIZE: tried once more in the next step, then X_VIDEO_FINALIZE_FAILED", async (_name, answer) => {
      const first = fakeStore(appendState(SEGMENTS));
      stubX({ finalize: [answer()] });
      const pausedResult = await run(bigCtx(first.store));
      vi.unstubAllGlobals();

      const second = fakeStore(appendState(SEGMENTS, { failedSegmentRetries: 1 }));
      const x = stubX({ finalize: [answer()] });
      const error = await failure(bigCtx(second.store));

      expect(pausedResult).toEqual(paused(NOW + RESUME_DELAY_MS));
      expect(first.saves().at(-1)).toEqual({ ...appendState(SEGMENTS).data, failedSegmentRetries: 1 });
      expect(error?.code).toBe("X_VIDEO_FINALIZE_FAILED");
      expect(error?.status).toBeUndefined();
      expect(x.tweets()).toHaveLength(0);
    });

    it("a 400 on FINALIZE is X_VIDEO_FINALIZE_FAILED at once", async () => {
      const { store } = fakeStore(appendState(SEGMENTS));
      stubX({ finalize: [reply(400, "not all segments")] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "X_VIDEO_FINALIZE_FAILED", status: 400 });
    });

    it("a 429 on FINALIZE saves the position, then throws RATE_LIMITED", async () => {
      const { store, mocks, saved } = fakeStore(appendState(SEGMENTS));
      stubX({ finalize: [limited()] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: null });
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(saved()?.data).toEqual(appendState(SEGMENTS).data);
    });

    it("a 429 on INIT is RATE_LIMITED and nothing is saved", async () => {
      const { store, mocks } = fakeStore();
      stubX({ init: [limited()] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a 5xx on INIT keeps today's X_VIDEO_INIT_FAILED with its status; an answer with no media id is the same code", async () => {
      const serverError = fakeStore();
      stubX({ init: [reply(503)] });
      const failed = await failure(bigCtx(serverError.store));
      vi.unstubAllGlobals();

      const noId = fakeStore();
      stubX({ init: [() => json({ expires_after_secs: 100 })] });
      const missing = await failure(bigCtx(noId.store));

      expect(failed).toMatchObject({ code: "X_VIDEO_INIT_FAILED", status: 503 });
      expect(missing?.code).toBe("X_VIDEO_INIT_FAILED");
      expect(serverError.mocks.save).not.toHaveBeenCalled();
      expect(noId.mocks.save).not.toHaveBeenCalled();
    });
  });

  describe("the tweet (the commit call)", () => {
    const resetSec = () => Math.floor(NOW / 1000) + 900;

    it("is sent once, after processing succeeded, with the media id and the caption", async () => {
      const { store } = fakeStore(processingState(30_000));
      const x = stubX({ status: [statusInProgress(5), statusSucceeded] });

      const result = await run(bigCtx(store, { caption: "a caption" }));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(x.sequence()).toEqual(["STATUS", "STATUS", "v1"]);
      expect(Object.fromEntries(formOf(x.v1Calls()[0]))).toEqual({ status: "a caption", media_ids: "m1" });
      expect(headersOf(x.v1Calls()[0][1])["Authorization"]).toMatch(/^OAuth /);
    });

    it("truncates a caption over 280 characters the way the small path does", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX();
      const caption = "word ".repeat(100);

      await run(bigCtx(store, { caption }));

      expect(formOf(x.v1Calls()[0]).get("status")).toBe(computeTweetText(caption));
    });

    it("falls back to v2 when v1.1 rejects it, with the same media id", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [reply(403, JSON.stringify({ errors: [{ code: 187 }] }))] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-2" });
      expect(JSON.parse(String(x.v2Calls()[0][1]?.body))).toEqual({ text: "hello", media: { media_ids: ["m1"] } });
    });

    it("v1.1 502 is PUBLISH_UNCONFIRMED, v2 is NOT requested, and the in-step retry does not repeat anything", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [reply(502)] });

      await expect(
        withTransientRetries(() => xClient.publishVideo(bigCtx(store)), { sleep: async () => {} }),
      ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED", message: PUBLISH_UNCONFIRMED_MESSAGE });
      expect(x.v1Calls()).toHaveLength(1);
      expect(x.v2Calls()).toHaveLength(0);
      expect(x.sequence()).toEqual(["v1"]);
    });

    it("v1.1 connection dropped after sending is PUBLISH_UNCONFIRMED, v2 NOT requested", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [connectionReset()] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(x.v2Calls()).toHaveLength(0);
    });

    it("v1.1 timeout is PUBLISH_UNCONFIRMED, v2 NOT requested", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [timeoutFailure()] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(x.v2Calls()).toHaveLength(0);
    });

    it("v1.1 never connected: the same TypeError, rethrown, and the state still waits for the tweet", async () => {
      const { store, saved } = fakeStore(readyState());
      const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubX({ v1: [failWith(refused)] });

      expect(await failure(bigCtx(store))).toBe(refused);
      expect(saved()?.data).toEqual(readyState().data);
    });

    it("v2 502 after a v1.1 rejection is PUBLISH_UNCONFIRMED, requested once", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [reply(403)], v2: [reply(502)] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(x.v2Calls()).toHaveLength(1);
    });

    it("a 2xx answer with no id is PUBLISH_UNCONFIRMED and v2 is NOT requested", async () => {
      const { store } = fakeStore(readyState());
      const x = stubX({ v1: [() => json({}, 200)] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(x.v2Calls()).toHaveLength(0);
    });

    it("once processing succeeded, `ready` is saved before the tweet is tried, whatever then happens to the tweet", async () => {
      const { store, saved } = fakeStore(processingState(30_000));
      const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubX({ status: [statusSucceeded], v1: [failWith(refused)] });

      expect(await failure(bigCtx(store))).toBe(refused);
      expect(saved()?.data).toMatchObject({ phase: "ready", mediaId: "m1" });
    });

    it("a v2 tweet that X rejects is X_TWEET_FAILED", async () => {
      const { store } = fakeStore(readyState());
      stubX({ v1: [reply(403)], v2: [reply(403, "{}")] });

      expect((await failure(bigCtx(store)))?.code).toBe("X_TWEET_FAILED");
    });

    it("a 2xx answer that carries rate-limit headers is the success it is, never RATE_LIMITED", async () => {
      const headers = {
        "x-rate-limit-limit": "50",
        "x-rate-limit-remaining": "0",
        "x-rate-limit-reset": String(resetSec()),
        "retry-after": "60",
      };
      const viaV1 = fakeStore(readyState());
      stubX({ v1: [() => json({ id_str: "tweet-1" }, 200, headers)] });
      const first = await run(bigCtx(viaV1.store));
      vi.unstubAllGlobals();

      const viaV2 = fakeStore(readyState());
      stubX({ v1: [reply(403)], v2: [() => json({ data: { id: "tweet-2" } }, 201, headers)] });
      const second = await run(bigCtx(viaV2.store));

      expect(first).toEqual({ externalPostId: "tweet-1" });
      expect(second).toEqual({ externalPostId: "tweet-2" });
    });

    it("a real 429 on v2 saves `ready`, throws RATE_LIMITED, and the deferred step sends only the tweet", async () => {
      const { store, saved, mocks } = fakeStore(processingState(30_000));
      const first = stubX({ status: [statusSucceeded], v1: [reply(429)], v2: [limited(resetSec())] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: resetSec() * 1000 });
      expect(saved()?.data).toMatchObject({ phase: "ready", mediaId: "m1" });
      expect(first.v2Calls()).toHaveLength(1);
      vi.unstubAllGlobals();

      const second = stubX();
      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "tweet-1" });
      expect(second.sequence()).toEqual(["v1"]);
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("is never sent while processing is unfinished", async () => {
      const { store } = fakeStore(appendState(SEGMENTS - 1));
      const x = stubX({ finalize: [after(STEP - 30_000, finalizeProcessing("pending", 5))] });

      const result = await run(bigCtx(store));

      expect(result).toMatchObject({ continuation: expect.any(Object) });
      expect(x.tweets()).toHaveLength(0);
    });
  });

  describe("the blob", () => {
    it("a body that drops part-way through pauses 30 s, nothing sent and no failure counted against the segment", async () => {
      const { store, saves } = fakeStore(appendState(10));
      const x = stubX({ blobBodyFailure: new TypeError("terminated") });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY_MS));
      expect(x.appends()).toHaveLength(0);
      expect(saves().at(-1)).toEqual(appendState(10).data);
    });

    it("an unreadable blob fails the upload before any segment is sent", async () => {
      const { store, mocks } = fakeStore(appendState(10));
      const x = stubX({ blobStatus: 404 });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "BLOB_READ_FAILED", status: 404 });
      expect(x.appends()).toHaveLength(0);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a blob whose size is not the recorded size fails with MEDIA_SIZE_MISMATCH before any segment is sent", async () => {
      const { store } = fakeStore(appendState(10));
      const x = stubX({ blobClaimsTotal: TOTAL + 1 });

      expect((await failure(bigCtx(store)))?.code).toBe("MEDIA_SIZE_MISMATCH");
      expect(x.appends()).toHaveLength(0);
    });
  });

  describe("no credentials or URLs in saved state, results, errors or logs", () => {
    it("a whole upload over two steps saves only progress: no sealed secret, no credential, no URL", async () => {
      const first = fakeStore();
      stubX({ append: [lastSegmentOfTheStep], init: [initOk(1, { expires_after_secs: 86_400 })] });
      const step1 = await run(bigCtx(first.store));
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW + 10 * MINUTE);
      const second = fakeStore(appendState(SEGMENTS - 1));
      stubX({ finalize: [finalizeProcessing("pending", 5)], status: [statusSucceeded] });
      const step2 = await run(bigCtx(second.store));

      const snapshots = [...first.mocks.save.mock.calls, ...second.mocks.save.mock.calls] as Array<
        [string, { data: StateData; secret?: unknown }]
      >;
      expect(snapshots.length).toBeGreaterThan(2);
      for (const [kind, snapshot] of snapshots) {
        expect(kind).toBe(X_UPLOAD_STATE_KIND);
        expect(snapshot.secret).toBeUndefined();
        expect(Object.keys(snapshot.data).sort()).toEqual(
          ["expiresAt", "failedSegmentRetries", "mediaId", "nextSegment", "phase", "totalBytes", ...(snapshot.data.finalizedAt === undefined ? [] : ["finalizedAt"])].sort(),
        );
        expectNoCredentials(JSON.stringify(snapshot.data));
        expect(JSON.stringify(snapshot.data)).not.toContain("://");
        expect(JSON.stringify(snapshot.data)).not.toContain("blob.example.com");
      }
      expectNoCredentials(JSON.stringify(step1), JSON.stringify(step2), everythingLogged());
    });

    const failures: Array<[string, () => { data: StateData }, Parameters<typeof stubX>[0]]> = [
      ["a 400 on a segment", () => appendState(10), { append: [reply(400, "bad")] }],
      ["a second 503 on a segment", () => appendState(10, { failedSegmentRetries: 1 }), { append: [reply(503)] }],
      ["a 429 on a segment", () => appendState(10), { append: [limited()] }],
      ["a 400 on FINALIZE", () => appendState(SEGMENTS), { finalize: [reply(400, "no")] }],
      ["processing that failed", () => processingState(), { status: [() => json({ processing_info: { state: "failed" } })] }],
      ["a 400 on STATUS", () => processingState(), { status: [reply(400, "no")] }],
      ["a v1.1 502", () => readyState(), { v1: [reply(502)] }],
      ["a v1.1 and a v2 rejection", () => readyState(), { v1: [reply(403)], v2: [reply(403, "{}")] }],
    ];

    it.each(failures)("%s: the error and the logs carry no credential", async (_name, state, routes) => {
      const { store } = fakeStore(state());
      stubX(routes);

      const error = await failure(bigCtx(store));

      expect(error).not.toBeNull();
      expectNoCredentials(describeError(error), everythingLogged());
    });
  });
});


// 07b: a post with several photos becomes ONE X post with up to 4 photos
// (https://docs.x.com/x-api/posts/create-post: "A Post may include up to 4 photos";
// `media.media_ids` are attached "in the order given"). Each photo goes through the same
// whole-file image upload the single-photo path uses; then one tweet create names every
// media id. Photos after the fourth are left out. Each X post is paid for, so a multi-photo
// post must never create more than one.
describe("xClient.publishVideo — several photos in one post (07b)", () => {
  type Call = Parameters<typeof fetch>;
  type Reply = () => Response | Promise<Response>;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  /** Photo n is stored at .../pn and holds the single byte n, so its upload is recognisable. */
  const photo = (n: number, mimeType = "image/jpeg") =>
    ({
      id: `media-${n}`,
      mimeType,
      storageLocation: `https://blob.example.com/p${n}`,
      sizeBytes: 1,
      originalFilename: `p${n}.jpg`,
      baseCaption: "",
      perPlatformOverrides: null,
    }) as unknown as MediaItem;

  function photosCtx(items: MediaItem[], over: Partial<PublishContext> = {}): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-x",
        platform: "x",
        accessToken: "access-token",
        refreshToken: "access-token-secret",
      } as unknown as SocialConnection,
      mediaItem: { ...items[0], baseCaption: "ignored base caption" } as MediaItem,
      mediaItems: items,
      caption: "hello @someone there",
      ...over,
    };
  }
  const photos = (count: number) => Array.from({ length: count }, (_, i) => photo(i + 1));

  const labelOf = (call: Call): string => {
    const url = String(call[0]);
    const blob = /blob\.example\.com\/(p\d+)/.exec(url);
    if (blob) return blob[1];
    if (url.includes("upload.twitter.com")) return "IMAGE";
    if (url.includes("statuses/update.json")) return "v1";
    if (url.includes("/2/tweets")) return "v2";
    return "?";
  };

  /**
   * Fakes the blob and X. The image upload answers media id `10<n>` for photo n (read from the
   * uploaded bytes). Each route has a script of answers used in order, then a default.
   */
  function stubX(opts: { image?: Reply[]; blob?: Record<number, Reply>; v1?: Reply[]; v2?: Reply[] } = {}) {
    const image = [...(opts.image ?? [])];
    const v1 = [...(opts.v1 ?? [])];
    const v2 = [...(opts.v2 ?? [])];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const blob = /blob\.example\.com\/p(\d+)/.exec(url);
      if (blob) {
        const n = Number(blob[1]);
        return (opts.blob?.[n] ?? (() => new Response(new Uint8Array([n]))))();
      }
      if (url.includes("upload.twitter.com")) {
        const scripted = image.shift();
        if (scripted) return scripted();
        const data = (init?.body as URLSearchParams).get("media_data") ?? "";
        return json({ media_id_string: `10${Buffer.from(data, "base64")[0]}` });
      }
      if (url.includes("statuses/update.json")) return (v1.shift() ?? (() => json({ id_str: "tweet-1" })))();
      if (url.includes("/2/tweets")) return (v2.shift() ?? (() => json({ data: { id: "tweet-2", text: "x" } }, 201)))();
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const where = (label: string) => fetchMock.mock.calls.filter((c) => labelOf(c) === label);
    return {
      fetchMock,
      sequence: () => fetchMock.mock.calls.map(labelOf),
      v1Calls: () => where("v1"),
      v2Calls: () => where("v2"),
      tweets: () => [...where("v1"), ...where("v2")],
    };
  }
  const formOf = (call: Call | undefined) => (call?.[1] as RequestInit).body as URLSearchParams;
  const jsonOf = (call: Call | undefined) => JSON.parse(String((call?.[1] as RequestInit).body)) as unknown;

  const failure = (c: PublishContext) =>
    xClient.publishVideo(c).then(
      () => null,
      (e: unknown) => e as Error & { code?: string; status?: number },
    );

  beforeEach(() => {
    vi.stubEnv("X_CONSUMER_KEY", "consumer-key");
    vi.stubEnv("X_CONSUMER_SECRET", "consumer-secret");
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("one photo: the same requests as before (one upload, one v1.1 tweet with its media id)", async () => {
    const x = stubX();

    const result = await xClient.publishVideo(photosCtx([photo(1)], { caption: "hello" }));

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence()).toEqual(["p1", "IMAGE", "v1"]);
    expect(Object.fromEntries(formOf(x.v1Calls()[0]))).toEqual({ status: "hello", media_ids: "101" });
  });

  it("two photos: each uploaded in order, then ONE tweet with both media ids and the caption", async () => {
    const x = stubX();

    const result = await xClient.publishVideo(photosCtx(photos(2)));

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence()).toEqual(["p1", "IMAGE", "p2", "IMAGE", "v1"]);
    // The text comes from ctx.caption (mentions removed, as for one photo), never from mediaItems.
    expect(Object.fromEntries(formOf(x.v1Calls()[0]))).toEqual({
      status: computeTweetText("hello @someone there"),
      media_ids: "101,102",
    });
    expect(x.tweets()).toHaveLength(1);
  });

  it("four photos: four uploads in order, then one tweet naming all four", async () => {
    const x = stubX();

    const result = await xClient.publishVideo(photosCtx(photos(4)));

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence()).toEqual(["p1", "IMAGE", "p2", "IMAGE", "p3", "IMAGE", "p4", "IMAGE", "v1"]);
    expect(formOf(x.v1Calls()[0]).get("media_ids")).toBe("101,102,103,104");
    expect(x.tweets()).toHaveLength(1);
  });

  it("five photos: only the first four are downloaded and sent; the fifth is left out", async () => {
    const x = stubX();

    const result = await xClient.publishVideo(photosCtx(photos(5)));

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence()).toEqual(["p1", "IMAGE", "p2", "IMAGE", "p3", "IMAGE", "p4", "IMAGE", "v1"]);
    expect(formOf(x.v1Calls()[0]).get("media_ids")).toBe("101,102,103,104");
  });

  it("ten photos: still four uploads and one tweet", async () => {
    const x = stubX();

    await expect(xClient.publishVideo(photosCtx(photos(10)))).resolves.toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence().filter((l) => l === "IMAGE")).toHaveLength(4);
    expect(x.tweets()).toHaveLength(1);
  });

  it("v1.1 rejected: the v2 fallback carries the same media ids in order, as a JSON array", async () => {
    const x = stubX({ v1: [() => json({ errors: [] }, 403)] });

    const result = await xClient.publishVideo(photosCtx(photos(5)));

    expect(result).toEqual({ externalPostId: "tweet-2" });
    expect(x.v2Calls()).toHaveLength(1);
    expect(jsonOf(x.v2Calls()[0])).toEqual({
      text: computeTweetText("hello @someone there"),
      media: { media_ids: ["101", "102", "103", "104"] },
    });
  });

  it("the second photo's upload fails: no tweet, one clear message naming the photo", async () => {
    const x = stubX({ image: [() => json({ media_id_string: "101" }), () => json({ error: "bad" }, 400)] });

    const error = await failure(photosCtx(photos(3)));

    expect(error?.code).toBe("X_IMAGE_UPLOAD_FAILED");
    expect(error?.status).toBe(400);
    expect(error?.message).toBe(
      "Photo 2 of 3 could not be uploaded to X (X media upload failed (status 400)). No post was created.",
    );
    expect(x.sequence()).toEqual(["p1", "IMAGE", "p2", "IMAGE"]);
    expect(x.tweets()).toHaveLength(0);
  });

  it("the second photo cannot be read from storage: no tweet, one clear message", async () => {
    const x = stubX({ blob: { 2: () => new Response(null, { status: 404 }) } });

    const error = await failure(photosCtx(photos(2)));

    expect(error?.code).toBe("X_MEDIA_DOWNLOAD_FAILED");
    expect(error?.message).toBe(
      "Photo 2 of 2 could not be uploaded to X (Failed to fetch media from storage (status 404)). No post was created.",
    );
    expect(x.tweets()).toHaveLength(0);
  });

  it("a rate limit on a photo upload stays RATE_LIMITED, and no tweet is made", async () => {
    const x = stubX({ image: [() => json({ media_id_string: "101" }), () => new Response("", { status: 429 })] });

    const error = await failure(photosCtx(photos(2)));

    expect(error?.code).toBe("RATE_LIMITED");
    expect(x.tweets()).toHaveLength(0);
  });

  it("the tweet create answers 502: PUBLISH_UNCONFIRMED, sent once, no v2, not re-run by the in-step retry", async () => {
    const x = stubX({ v1: [() => json({ errors: [] }, 502)] });

    await expect(
      withTransientRetries(() => xClient.publishVideo(photosCtx(photos(3))), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED", message: PUBLISH_UNCONFIRMED_MESSAGE });
    expect(x.v1Calls()).toHaveLength(1);
    expect(x.v2Calls()).toHaveLength(0);
  });

  it("the tweet create times out: PUBLISH_UNCONFIRMED, sent once", async () => {
    const timeout = Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" });
    const x = stubX({ v1: [() => Promise.reject(timeout)] });

    expect((await failure(photosCtx(photos(2))))?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(x.tweets()).toHaveLength(1);
  });

  it.each([
    ["a video", "video/mp4"],
    ["a GIF", "image/gif"],
    ["no type", ""],
  ])("%s among several photos: nothing is sent", async (_name, mimeType) => {
    const x = stubX();

    const error = await failure(photosCtx([photo(1), photo(2, mimeType), photo(3)]));

    expect(error?.code).toBe("X_INVALID_MEDIA_TYPE");
    expect(x.fetchMock).not.toHaveBeenCalled();
  });

  it("a non-image after the fourth photo is refused too (nothing sent)", async () => {
    const x = stubX();

    const error = await failure(photosCtx([...photos(4), photo(5, "video/mp4")]));

    expect(error?.code).toBe("X_INVALID_MEDIA_TYPE");
    expect(x.fetchMock).not.toHaveBeenCalled();
  });

  it("does not read or write the saved upload state (that is the video path's)", async () => {
    stubX();
    const store = { load: vi.fn(), save: vi.fn(), clear: vi.fn() } as unknown as UploadStateStore;

    await xClient.publishVideo(photosCtx(photos(2), { uploadState: store }));

    expect(vi.mocked(store.load)).not.toHaveBeenCalled();
    expect(vi.mocked(store.save)).not.toHaveBeenCalled();
  });

  it("a spent step budget: nothing is sent", async () => {
    const x = stubX();

    const error = await failure(photosCtx(photos(2), { deadline: Date.now() + 1_000 }));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(x.fetchMock).not.toHaveBeenCalled();
  });
});

// 07d: alt text. X API reference "Create Media metadata" (read 2026-11-10):
// POST https://api.x.com/2/media/metadata, JSON {"id", "metadata": {"alt_text": {"text"}}},
// text maxLength 1000, OAuth 2 (media.write) or the OAuth 1.0a user token this client
// signs with. It is set on the uploaded media before the post; a failure posts the
// photo without it and never repeats an upload or the post.
describe("xClient.publishVideo — alt text (07d)", () => {
  type Call = Parameters<typeof fetch>;
  type Reply = () => Response | Promise<Response>;
  const META_URL = "https://api.x.com/2/media/metadata";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const photo = (n: number, altText: string | null, mimeType = "image/jpeg") =>
    ({
      id: `media-${n}`,
      mimeType,
      storageLocation: `https://blob.example.com/p${n}`,
      sizeBytes: 1,
      originalFilename: `p${n}.jpg`,
      baseCaption: "",
      perPlatformOverrides: null,
      altText,
    }) as unknown as MediaItem;

  function ctx(items: MediaItem[], over: Partial<PublishContext> = {}): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: {
        id: "conn-x",
        platform: "x",
        accessToken: "access-token",
        refreshToken: "access-token-secret",
      } as unknown as SocialConnection,
      mediaItem: items[0],
      mediaItems: items,
      caption: "hello",
      ...over,
    };
  }

  const labelOf = (call: Call): string => {
    const url = String(call[0]);
    const blob = /blob\.example\.com\/(p\d+)/.exec(url);
    if (blob) return blob[1];
    if (url.includes("upload.twitter.com")) return "IMAGE";
    if (url === META_URL) return "META";
    if (url.includes("statuses/update.json")) return "v1";
    if (url.includes("/2/tweets")) return "v2";
    return "?";
  };

  function stubX(opts: { meta?: Reply } = {}) {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const blob = /blob\.example\.com\/p(\d+)/.exec(url);
      if (blob) return new Response(new Uint8Array([Number(blob[1])]));
      if (url.includes("upload.twitter.com")) {
        const data = (init?.body as URLSearchParams).get("media_data") ?? "";
        return json({ media_id_string: `10${Buffer.from(data, "base64")[0]}` });
      }
      if (url === META_URL) {
        return (opts.meta ?? (() => json({ data: { id: "x", associated_metadata: {} } })))();
      }
      if (url.includes("statuses/update.json")) return json({ id_str: "tweet-1" });
      if (url.includes("/2/tweets")) return json({ data: { id: "tweet-2", text: "x" } }, 201);
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      sequence: () => fetchMock.mock.calls.map(labelOf),
      metaCalls: () => fetchMock.mock.calls.filter((c) => labelOf(c) === "META"),
      v1Calls: () => fetchMock.mock.calls.filter((c) => labelOf(c) === "v1"),
    };
  }
  const jsonOf = (call: Call | undefined) => JSON.parse(String((call?.[1] as RequestInit).body)) as unknown;
  const logged = () =>
    JSON.stringify((["log", "warn", "error"] as const).map((level) => vi.mocked(console[level]).mock.calls));

  beforeEach(() => {
    vi.stubEnv("X_CONSUMER_KEY", "consumer-key");
    vi.stubEnv("X_CONSUMER_SECRET", "consumer-secret");
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("one photo with a description: upload, then the metadata call, then the post", async () => {
    const x = stubX();

    const result = await xClient.publishVideo(ctx([photo(1, "A dog on a beach.")]));

    expect(result).toEqual({ externalPostId: "tweet-1" });
    expect(x.sequence()).toEqual(["p1", "IMAGE", "META", "v1"]);
    const [meta] = x.metaCalls();
    const init = meta[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^OAuth /);
    expect(jsonOf(meta)).toEqual({ id: "101", metadata: { alt_text: { text: "A dog on a beach." } } });
    expect(Object.fromEntries((x.v1Calls()[0][1] as RequestInit).body as URLSearchParams)).toEqual({
      status: "hello",
      media_ids: "101",
    });
  });

  it("one photo without one: exactly today's requests, no metadata call", async () => {
    for (const altText of [null, "", "  "]) {
      const x = stubX();
      await xClient.publishVideo(ctx([photo(1, altText)]));
      expect(x.sequence()).toEqual(["p1", "IMAGE", "v1"]);
    }
  });

  it("several photos: each uploaded photo with a description gets its own call, all before the one post", async () => {
    const x = stubX();

    await xClient.publishVideo(ctx([photo(1, "First."), photo(2, null), photo(3, "Third.")]));

    expect(x.sequence()).toEqual(["p1", "IMAGE", "p2", "IMAGE", "p3", "IMAGE", "META", "META", "v1"]);
    expect(x.metaCalls().map(jsonOf)).toEqual([
      { id: "101", metadata: { alt_text: { text: "First." } } },
      { id: "103", metadata: { alt_text: { text: "Third." } } },
    ]);
  });

  it("a fifth photo, left out of the post, gets no call", async () => {
    const x = stubX();

    await xClient.publishVideo(ctx([1, 2, 3, 4, 5].map((n) => photo(n, `Photo ${n}.`))));

    expect(x.metaCalls().map((c) => (jsonOf(c) as { id: string }).id)).toEqual(["101", "102", "103", "104"]);
  });

  it("cuts the description to X's 1,000 characters", async () => {
    const x = stubX();

    await xClient.publishVideo(ctx([photo(1, "word ".repeat(300))]));

    const text = (jsonOf(x.metaCalls()[0]) as { metadata: { alt_text: { text: string } } }).metadata.alt_text.text;
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    ["a 400", () => json({ errors: [{ message: "bad" }] }, 400)],
    ["a 429", () => json({}, 429)],
    ["a 500", () => json({}, 500)],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s on the metadata call: the photo still posts once, without the text in the log", async (_name, meta) => {
    const x = stubX({ meta });

    const result = await withTransientRetries(
      () => xClient.publishVideo(ctx([photo(1, "Secret description words.")])),
      { sleep: async () => {} },
    );

    expect(result).toEqual({ externalPostId: "tweet-1" });
    // One upload, one metadata call, one post: never a second upload or post.
    expect(x.sequence()).toEqual(["p1", "IMAGE", "META", "v1"]);
    expect(logged()).not.toContain("Secret description words.");
  });

  it("skips the metadata call when the step has too little time left for it and the post", async () => {
    const x = stubX();
    const deadline = Date.now() + X_TWEET_MIN_WINDOW_MS + 1_000;

    await xClient.publishVideo(ctx([photo(1, "A dog.")], { deadline }));

    expect(x.sequence()).toEqual(["p1", "IMAGE", "v1"]);
  });

  it("a video never gets a metadata call", async () => {
    const x = stubX();
    x.fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("blob.example.com")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.includes("upload.twitter.com")) {
        return json({ media_id_string: "900", processing_info: { state: "succeeded" } });
      }
      if (url.includes("statuses/update.json")) return json({ id_str: "tweet-1" });
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    await xClient.publishVideo(ctx([photo(1, "A clip.", "video/mp4")])).catch(() => null);

    expect(x.metaCalls()).toHaveLength(0);
  });
});
