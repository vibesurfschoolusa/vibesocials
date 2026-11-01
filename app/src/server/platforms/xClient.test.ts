import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { truncateGraphemes } from "@/lib/truncate";

import { PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
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

