import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { truncateGraphemes } from "@/lib/truncate";

import { PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
import { withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import {
  computeTweetText,
  X_PROCESSING_MAX_WAIT_MS,
  X_STATUS_MAX_INTERVAL_MS,
  X_TWEET_RESERVE_MS,
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
