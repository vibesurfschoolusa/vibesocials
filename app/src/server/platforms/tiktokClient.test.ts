import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { truncateGraphemes } from "@/lib/truncate";
import type { UploadStateStore } from "@/server/jobs/uploadState";

import { LARGE_UPLOAD_CHUNK_WINDOW_MS, LARGE_VIDEO_THRESHOLD_BYTES } from "./largeUpload";
import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";
import { isTransientPublishError, withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import {
  computeChunkPlan,
  computeTikTokCaption,
  decidePollOutcome,
  ensureFreshTikTokToken,
  pollTikTokPublishStatus,
  refreshTikTokToken,
  TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS,
  TIKTOK_MAX_CHUNK_SIZE,
  TIKTOK_MAX_FINAL_CHUNK_SIZE,
  TIKTOK_POLL_INTERVAL_MS,
  TIKTOK_POLL_MAX_ATTEMPTS,
  TIKTOK_PUBLIC_ACCOUNT_NOT_ALLOWED_MESSAGE,
  TIKTOK_TRANSIENT_RESUME_DELAY_MS,
  TIKTOK_UPLOAD_STATE_KIND,
  TIKTOK_UPLOAD_URL_SAFETY_MS,
  TIKTOK_UPLOAD_URL_TTL_MS,
  tiktokClient,
} from "./tiktokClient";

// markConnectionNeedsReconnect and the token-refresh persist both resolve
// prisma via `await import("@/lib/db")` at call time, so they receive this
// mock. No real database is touched, and no real TikTok endpoint is called:
// every network call below goes through a stubbed global `fetch`.
const { updateMock, findUniqueMock, refreshConnectionTokenMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
      // The guarded reconnect flag re-reads the stored tokens (connectionHealth.ts).
      findUnique: findUniqueMock,
    },
  },
}));

// The per-connection refresh lock has its own suite (connectionRefresh.test.ts).
// Here it is a pass-through spy: the tests below assert that every refresh is
// routed through it, with the step deadline, and exercise the refresher itself.
vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
}));

const MB = 1024 * 1024;

const RECONNECT_CODE = "TIKTOK_RECONNECT_REQUIRED";
const PENDING_MESSAGE =
  "TikTok is still processing this video — it may still appear on your account. Check TikTok before retrying.";

type CodedError = Error & { code?: string; status?: number };

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "tiktok",
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    // Default: comfortably fresh, so publish tests don't trigger a refresh.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    accountIdentifier: "open-id-1",
    scopes: null,
    metadata: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function caught(promise: Promise<unknown>): Promise<CodedError | null> {
  return promise.then(
    () => null,
    (e: unknown) => e as CodedError,
  );
}

/** The `data` payload of every `socialConnection.update` call, in order. */
function updateCalls(): Array<{ where: { id: string }; data: Record<string, unknown> }> {
  return updateMock.mock.calls.map(
    (c) => c[0] as { where: { id: string }; data: Record<string, unknown> },
  );
}

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...makeConnection(), ...args.data }),
  );
  // By default the database still holds the tokens makeConnection() builds, so
  // the guarded flag finds them unchanged and writes.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
  });
  refreshConnectionTokenMock.mockReset();
  refreshConnectionTokenMock.mockImplementation(
    (
      snapshot: SocialConnection,
      refresh: (current: SocialConnection) => Promise<SocialConnection>,
    ) => refresh(snapshot),
  );
  vi.stubEnv("TIKTOK_CLIENT_KEY", "test-client-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "test-client-secret");
  // The client logs progress and failures; keep test output pristine.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("computeChunkPlan", () => {
  // Every plan must fully and contiguously cover [0, size) using exactly
  // `totalChunks` chunks, and no chunk may exceed TikTok's 128MB final-chunk
  // cap. Returns the plan so callers can assert further specifics.
  function assertFullCoverage(size: number, plan = computeChunkPlan(size)) {
    expect(plan.ranges).toHaveLength(plan.totalChunks);
    expect(plan.ranges.length).toBeGreaterThan(0);
    expect(plan.ranges[0].start).toBe(0);
    expect(plan.ranges[plan.ranges.length - 1].end).toBe(size);

    let cursor = 0;
    for (const { start, end } of plan.ranges) {
      expect(start).toBe(cursor); // contiguous: no gaps, no overlaps
      expect(end).toBeGreaterThan(start); // non-empty chunk
      expect(end - start).toBeLessThanOrEqual(TIKTOK_MAX_FINAL_CHUNK_SIZE);
      cursor = end;
    }
    // The sum of all chunk lengths equals the declared video_size, so the whole
    // file is uploaded (this is exactly what the old floor-math dropped).
    expect(cursor).toBe(size);
    return plan;
  }

  it("uses a single whole-file chunk for a tiny 1KB file", () => {
    const plan = assertFullCoverage(1024);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(1024);
    expect(plan.ranges).toEqual([{ start: 0, end: 1024 }]);
  });

  it("uses a single chunk for a file exactly at the 10MB chunk size", () => {
    const size = 10 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(size);
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("keeps the trailing byte for 10MB + 1 (floor rule yields one fat chunk)", () => {
    const size = 10 * MB + 1;
    const plan = assertFullCoverage(size);
    // floor((10MB + 1) / 10MB) === 1, so the single chunk must still reach size.
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(TIKTOK_MAX_CHUNK_SIZE);
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("covers a 15MB file with a single fat chunk (10MB < size < 20MB)", () => {
    const size = 15 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(1); // floor(15 / 10) === 1
    expect(plan.ranges).toEqual([{ start: 0, end: size }]);
  });

  it("splits an exact 20MB multiple into two equal chunks", () => {
    const size = 20 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(2);
    expect(plan.ranges).toEqual([
      { start: 0, end: 10 * MB },
      { start: 10 * MB, end: 20 * MB },
    ]);
  });

  it("fattens the final chunk for 25MB (the reported data-loss case)", () => {
    const size = 25 * MB;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(2); // floor(25 / 10) === 2
    expect(plan.ranges).toEqual([
      { start: 0, end: 10 * MB },
      { start: 10 * MB, end: 25 * MB }, // final chunk absorbs the trailing 5MB
    ]);
    // Regression guard: the old code stopped at 20MB and dropped the last 5MB.
    expect(plan.ranges[plan.ranges.length - 1].end).toBe(size);
  });

  it("covers 64MB + 3 bytes with the trailing 3 bytes in the final chunk", () => {
    const size = 64 * MB + 3;
    const plan = assertFullCoverage(size);
    expect(plan.totalChunks).toBe(6); // floor((64MB + 3) / 10MB) === 6
    const last = plan.ranges[plan.ranges.length - 1];
    expect(last.end).toBe(size);
    // First 5 chunks are 10MB each; the final chunk holds the remaining bytes.
    expect(last.start).toBe(5 * 10 * MB);
    expect(last.end - last.start).toBe(size - 5 * 10 * MB); // 14MB + 3 bytes
  });

  it("honors a custom maxChunkSize and still covers the whole file", () => {
    const size = 25 * MB;
    const plan = assertFullCoverage(size, computeChunkPlan(size, 5 * MB));
    expect(plan.chunkSize).toBe(5 * MB);
    expect(plan.totalChunks).toBe(5); // floor(25 / 5) === 5
  });
});

// Roadmap Phase 7 (spec §7.1) — this locks computeTikTokCaption (extracted
// from publishVideo when it was refactored to read its limit from
// lib/platformLimits.ts instead of the inline `2200` literal) to the EXACT
// same output as the pre-refactor inline expression:
//
//   const tiktokCaption = caption
//     ? truncateGraphemes(caption, 2200)
//     : "Video posted via Vibe Socials";
//
// If this ever fails, either the refactor broke posting behavior or someone
// edited PLATFORM_CAPTION_LIMITS.tiktok without meaning to change what
// TikTok posts.
describe("computeTikTokCaption", () => {
  it("leaves an empty caption empty: no promotional default title (TikTok guideline 5b, 2026-11)", () => {
    expect(computeTikTokCaption("")).toBe("");
  });

  it("returns a caption under 2200 graphemes unchanged", () => {
    const caption = "Just a short caption";
    expect(computeTikTokCaption(caption)).toBe(caption);
  });

  it("returns a caption at exactly 2200 graphemes unchanged (boundary)", () => {
    const caption = "a".repeat(2200);
    expect(computeTikTokCaption(caption)).toBe(caption);
  });

  it("truncates a caption of length 2500 to exactly 2200 graphemes with no ellipsis", () => {
    const caption = "a".repeat(2500);
    const result = computeTikTokCaption(caption);
    expect(result).toHaveLength(2200);
    expect(result).toBe("a".repeat(2200));
  });

  it("matches the pre-refactor inline call byte-for-byte for a realistic long caption", () => {
    const caption = "The quick brown fox jumps over the lazy dog. ".repeat(60);
    expect(caption.length).toBeGreaterThan(2200);
    expect(computeTikTokCaption(caption)).toBe(truncateGraphemes(caption, 2200));
  });

  it("matches the pre-refactor inline call byte-for-byte for emoji/ZWJ-heavy content over the limit", () => {
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(500);
    expect(caption.length).toBeGreaterThan(2200);
    expect(computeTikTokCaption(caption)).toBe(truncateGraphemes(caption, 2200));
  });
});

// TikTok's /v2/post/publish/status/fetch/ returns UPPERCASE statuses
// (https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status):
// PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE,
// FAILED. The old code compared lowercase, so every post "timed out".
describe("decidePollOutcome", () => {
  it.each([
    // TikTok's real values.
    ["PUBLISH_COMPLETE", "complete"],
    ["SEND_TO_USER_INBOX", "complete"],
    ["FAILED", "failed"],
    ["PROCESSING_UPLOAD", "pending"],
    ["PROCESSING_DOWNLOAD", "pending"],
    // Normalization: case-insensitive (and whitespace-tolerant).
    ["publish_complete", "complete"],
    ["Failed", "failed"],
    ["  PUBLISH_COMPLETE ", "complete"],
    // Anything else is still pending.
    ["SOMETHING_NEW", "pending"],
    ["", "pending"],
    [undefined, "pending"],
    [null, "pending"],
  ] as const)("classifies %j as %s", (status, expected) => {
    expect(decidePollOutcome(status)).toBe(expected);
  });
});

describe("pollTikTokPublishStatus", () => {
  const noSleep = () => Promise.resolve();
  const pollConnection = { id: "conn-1", accessToken: "access-token", refreshToken: "refresh-1" };

  function statusResponse(status: string, failReason?: string): Response {
    return jsonResponse({
      data: { status, ...(failReason ? { fail_reason: failReason } : {}) },
      error: { code: "ok", message: "", log_id: "log-1" },
    });
  }

  function poll(overrides: Partial<Parameters<typeof pollTikTokPublishStatus>[0]> = {}) {
    return pollTikTokPublishStatus({
      accessToken: "access-token",
      publishId: "publish-1",
      connection: pollConnection,
      sleep: noSleep,
      ...overrides,
    });
  }

  it("uses a ~120s budget: 24 attempts x 5s", () => {
    expect(TIKTOK_POLL_MAX_ATTEMPTS).toBe(24);
    expect(TIKTOK_POLL_INTERVAL_MS).toBe(5_000);
    expect(TIKTOK_POLL_MAX_ATTEMPTS * TIKTOK_POLL_INTERVAL_MS).toBe(120_000);
  });

  it("resolves once TikTok reports PUBLISH_COMPLETE (uppercase), after pending polls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse("PROCESSING_UPLOAD"))
      .mockResolvedValueOnce(statusResponse("PROCESSING_DOWNLOAD"))
      .mockResolvedValueOnce(statusResponse("PUBLISH_COMPLETE"));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(poll({ sleep })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(5_000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/status/fetch/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(JSON.parse(init.body as string)).toEqual({ publish_id: "publish-1" });
  });

  it("treats SEND_TO_USER_INBOX as complete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse("SEND_TO_USER_INBOX")));
    await expect(poll()).resolves.toBeUndefined();
  });

  it("still accepts a lowercase publish_complete (normalization)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse("publish_complete")));
    await expect(poll()).resolves.toBeUndefined();
  });

  it("throws TIKTOK_PUBLISH_FAILED including TikTok's fail_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(statusResponse("FAILED", "file_format_check_failed")),
    );

    const error = await caught(poll());

    expect(error?.code).toBe("TIKTOK_PUBLISH_FAILED");
    expect(error?.message).toContain("file_format_check_failed");
  });

  it("throws TIKTOK_PUBLISH_FAILED without a reason suffix when fail_reason is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse("FAILED")));

    const error = await caught(poll());

    expect(error?.code).toBe("TIKTOK_PUBLISH_FAILED");
    expect(error?.message).toBe("TikTok failed to process the video");
  });

  it("does not echo an arbitrary (non-enum-looking) fail_reason into the user-facing message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(statusResponse("FAILED", "<script>alert(1)</script> secret=abc")),
    );

    const error = await caught(poll());

    expect(error?.code).toBe("TIKTOK_PUBLISH_FAILED");
    expect(error?.message).not.toContain("script");
    expect(error?.message).not.toContain("secret");
  });

  it("exhausts after 24 attempts (~120s) with TIKTOK_PUBLISH_PENDING and the exact guidance message", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(statusResponse("PROCESSING_UPLOAD")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const error = await caught(poll({ sleep }));

    expect(error?.code).toBe("TIKTOK_PUBLISH_PENDING");
    expect(error?.message).toBe(PENDING_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    const totalWaitMs = sleep.mock.calls.reduce((sum, c) => sum + (c[0] as number), 0);
    expect(totalWaitMs).toBe(120_000);
    // Exhaustion is NOT a reconnect problem.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps polling through transient HTTP 5xx and network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(statusResponse("PUBLISH_COMPLETE"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(poll()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // Task 4 item 10: the poll is the tail of a TikTok step; with a step
  // deadline it must never START a wait + status check that cannot finish
  // before the deadline — it stops early with TIKTOK_PUBLISH_PENDING instead.
  it("stops polling before the step deadline (TIKTOK_PUBLISH_PENDING), not after 24 attempts", async () => {
    let clock = 1_000_000;
    const fetchMock = vi.fn(async () => statusResponse("PROCESSING_UPLOAD"));
    vi.stubGlobal("fetch", fetchMock);
    const deadline = clock + 22_000;

    const error = await caught(
      poll({
        deadline,
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
      }),
    );

    expect(error?.code).toBe("TIKTOK_PUBLISH_PENDING");
    // A wait + check is started only with >= interval + MIN_REQUEST_WINDOW_MS
    // left: checks at +5s, +10s, +15s; at +15s only 7s remain -> stop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock).toBeLessThanOrEqual(deadline);
    expect(deadline - clock).toBeLessThan(TIKTOK_POLL_INTERVAL_MS + MIN_REQUEST_WINDOW_MS);
  });

  it("clamps each status check's timeout to the time left (a hung check ends by the deadline)", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 12_000;
    // A status request that never answers until it is aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    let settledAt = 0;
    const promise = caught(
      pollTikTokPublishStatus({
        accessToken: "a",
        publishId: "p",
        connection: { id: "c", accessToken: "a", refreshToken: null },
        deadline,
      }),
    ).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(60_000);

    // Unclamped, the one check (started at +5s) would hang for its full 30s.
    expect((await promise)?.code).toBe("TIKTOK_PUBLISH_PENDING");
    expect(settledAt).toBeLessThanOrEqual(deadline);
  });

  it("never lets a transient-looking error escape the poll phase (an in-step retry must not restart a publish TikTok may be processing)", async () => {
    const connectRefused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockRejectedValue(connectRefused);
    vi.stubGlobal("fetch", fetchMock);

    const error = await caught(poll());

    expect(error?.code).toBe("TIKTOK_PUBLISH_PENDING");
    expect(isTransientPublishError(error)).toBe(false);
  });

  // 2026-11-02 scale audit: the poll runs AFTER the final chunk went up, so
  // TikTok may already be posting. A 401 there still flags (guarded) but is never
  // a reconnect-and-retry, which can double-post: it is PUBLISH_UNCONFIRMED.
  describe("a 401 from the status endpoint (after the commit)", () => {
    const unauthorized = () =>
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "access_token_invalid", message: "bad token" } }, 401),
      );

    it("flags the connection (tokens unchanged) but throws PUBLISH_UNCONFIRMED, not the reconnect code", async () => {
      vi.stubGlobal("fetch", unauthorized());
      findUniqueMock.mockResolvedValue({ accessToken: "access-token", refreshToken: "refresh-1" });

      const error = await caught(
        poll({ connection: { id: "conn-42", accessToken: "access-token", refreshToken: "refresh-1" } }),
      );

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].where).toEqual({ id: "conn-42" });
      expect(updateCalls()[0].data.needsReconnect).toBe(true);
      expect(updateCalls()[0].data.lastRefreshErrorCode).toBe(RECONNECT_CODE);
    });

    it("does not flag when the stored tokens changed, and still throws PUBLISH_UNCONFIRMED", async () => {
      vi.stubGlobal("fetch", unauthorized());
      findUniqueMock.mockResolvedValue({ accessToken: "rotated-access", refreshToken: "refresh-1" });

      const error = await caught(poll());

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(updateCalls()).toHaveLength(0);
    });

    it("is not transient: an in-step retry must not restart a publish TikTok may be processing", async () => {
      vi.stubGlobal("fetch", unauthorized());

      const error = await caught(poll());

      expect(isTransientPublishError(error)).toBe(false);
    });
  });
});

describe("refreshTikTokToken", () => {
  it("POSTs the documented form fields to TikTok's token endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "new-access-token",
        expires_in: 86_400,
        refresh_token: "old-refresh-token",
        refresh_expires_in: 31_536_000,
        open_id: "open-id-1",
        scope: "video.publish",
        token_type: "Bearer",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshTikTokToken(makeConnection({ refreshToken: "refresh-xyz" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body.entries())).toEqual({
      client_key: "test-client-key",
      client_secret: "test-client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-xyz",
    });
  });

  it("persists the new access token + expiry and clears the health flags (never sets the flag alongside tokens)", async () => {
    const expiresIn = 86_400;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: "new-access-token",
          expires_in: expiresIn,
          refresh_token: "old-refresh-token", // unchanged -> not rewritten
          refresh_expires_in: 31_536_000,
        }),
      ),
    );

    const before = Date.now();
    const updated = await refreshTikTokToken(makeConnection({ id: "conn-42" }));
    const after = Date.now();

    expect(updateCalls()).toHaveLength(1);
    const { where, data } = updateCalls()[0];
    expect(where).toEqual({ id: "conn-42" });
    expect(Object.keys(data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(data.accessToken).toBe("new-access-token");
    expect(data.needsReconnect).toBe(false);
    expect(data.lastRefreshErrorCode).toBeNull();
    expect(data.refreshFailedAt).toBeNull();
    const expiresMs = (data.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + expiresIn * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + expiresIn * 1000);

    // Returns the persisted row (what db.ts hands back, tokens opened).
    expect(updated.accessToken).toBe("new-access-token");
  });

  it("persists a ROTATED refresh token (TikTok: the returned refresh_token may differ and must replace the old one)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          access_token: "new-access-token",
          expires_in: 86_400,
          refresh_token: "rotated-refresh-token",
          refresh_expires_in: 31_536_000,
        }),
      ),
    );

    await refreshTikTokToken(makeConnection({ refreshToken: "old-refresh-token" }));

    expect(updateCalls()[0].data.refreshToken).toBe("rotated-refresh-token");
  });

  it("does not touch refreshToken when the response omits it or returns it unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: "a1", expires_in: 86_400 }))
        .mockResolvedValueOnce(
          jsonResponse({ access_token: "a2", expires_in: 86_400, refresh_token: "old-refresh-token" }),
        ),
    );

    await refreshTikTokToken(makeConnection());
    await refreshTikTokToken(makeConnection());

    expect(updateCalls()[0].data).not.toHaveProperty("refreshToken");
    expect(updateCalls()[1].data).not.toHaveProperty("refreshToken");
  });

  it("falls back to TikTok's 24h access-token TTL when expires_in is missing, never persisting an Invalid Date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ access_token: "a1" })));

    const before = Date.now();
    await refreshTikTokToken(makeConnection());
    const after = Date.now();

    const expiresAt = updateCalls()[0].data.expiresAt as Date;
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 86_400_000);
  });

  describe("terminal failures (flag needsReconnect)", () => {
    it.each([
      ["HTTP 400 invalid_grant", 400, { error: "invalid_grant", error_description: "expired" }],
      ["HTTP 400 invalid_request", 400, { error: "invalid_request" }],
      ["HTTP 401", 401, { error: "invalid_token" }],
      ["HTTP 401 with an unparseable body", 401, null],
      ["HTTP 200 carrying error=invalid_grant and no access_token", 200, { error: "invalid_grant" }],
    ] as const)("%s", async (_label, status, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          body === null ? new Response("<html>nope</html>", { status }) : jsonResponse(body, status),
        ),
      );

      const error = await caught(refreshTikTokToken(makeConnection({ id: "conn-9" })));

      expect(error?.code).toBe(RECONNECT_CODE);
      // Exactly ONE write: the flag-only update. No tokens ride along.
      expect(updateCalls()).toHaveLength(1);
      const { where, data } = updateCalls()[0];
      expect(where).toEqual({ id: "conn-9" });
      expect(Object.keys(data).sort()).toEqual([
        "lastRefreshErrorCode",
        "needsReconnect",
        "refreshFailedAt",
      ]);
      expect(data.needsReconnect).toBe(true);
      expect(data.lastRefreshErrorCode).toBe(RECONNECT_CODE);
    });

    it("flags and throws a reconnect error when there is no refresh token at all, without any network call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      findUniqueMock.mockResolvedValue({ accessToken: "old-access-token", refreshToken: null });

      const error = await caught(refreshTikTokToken(makeConnection({ refreshToken: null })));

      expect(error?.code).toBe(RECONNECT_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].data.needsReconnect).toBe(true);
    });
  });

  // 2026-11-01 scale audit (jobs, token refresh): TikTok rotates the refresh
  // token, so when two processes refresh at once the loser gets invalid_grant
  // for a token the winner already replaced. That must not mark the working
  // connection dead.
  describe("superseded by another refresh (TikTok rotation race)", () => {
    const invalidGrant = () =>
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)));

    it("invalid_grant while the stored refresh token was already rotated: throws TOKEN_REFRESH_SUPERSEDED and never writes needsReconnect", async () => {
      invalidGrant();
      findUniqueMock.mockResolvedValue({
        accessToken: "winner-access-token",
        refreshToken: "winner-rotated-refresh-token",
      });

      const error = await caught(refreshTikTokToken(makeConnection({ id: "conn-race" })));

      expect(error?.code).toBe("TOKEN_REFRESH_SUPERSEDED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("compares the stored tokens with the ones this refresh sent", async () => {
      invalidGrant();

      await caught(
        refreshTikTokToken(
          makeConnection({ id: "conn-race", accessToken: "sent-access", refreshToken: "sent-refresh" }),
        ),
      );

      // The default stored row differs from what was sent -> superseded, no write.
      expect(findUniqueMock).toHaveBeenCalledWith({
        where: { id: "conn-race" },
        select: { accessToken: true, refreshToken: true },
      });
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("still flags when the stored tokens are the ones that failed (a genuinely dead grant)", async () => {
      invalidGrant();

      const error = await caught(refreshTikTokToken(makeConnection({ id: "conn-dead" })));

      expect(error?.code).toBe(RECONNECT_CODE);
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].data.needsReconnect).toBe(true);
    });

    it("a missing refresh token while the stored tokens changed: superseded, not flagged", async () => {
      findUniqueMock.mockResolvedValue({
        accessToken: "reconnected",
        refreshToken: "reconnected-refresh",
      });

      const error = await caught(refreshTikTokToken(makeConnection({ refreshToken: null })));

      expect(error?.code).toBe("TOKEN_REFRESH_SUPERSEDED");
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe("transient / non-terminal failures (throw WITHOUT flagging)", () => {
    it.each([
      ["HTTP 429", 429],
      ["HTTP 500", 500],
      ["HTTP 503", 503],
      ["HTTP 403 (not a documented terminal status)", 403],
    ] as const)("%s", async (_label, status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("upstream says: SECRET-BODY", { status })),
      );

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
      // status is carried so withTransientRetries can retry 429/5xx in-step.
      expect(error?.status).toBe(status);
      // Sanitized: never leaks the upstream body or tokens.
      expect(error?.message).not.toContain("SECRET-BODY");
      expect(error?.message).not.toContain("old-refresh-token");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("propagates a network failure unchanged (a TypeError) and does not flag", async () => {
      const networkError = new TypeError("fetch failed");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error).toBe(networkError);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("does not flag on 5xx even if the body says invalid_grant", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 502)),
      );

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("does not flag on invalid_client (a deployment/secret problem must not mark every user's connection dead)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_client" }, 401)),
      );

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("does not flag when a 200 response has neither access_token nor a recognizable error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("throws TIKTOK_MISSING_OAUTH_CREDENTIALS (no network, no flag) when the client env vars are absent", async () => {
      vi.stubEnv("TIKTOK_CLIENT_KEY", "");
      vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const error = await caught(refreshTikTokToken(makeConnection()));

      expect(error?.code).toBe("TIKTOK_MISSING_OAUTH_CREDENTIALS");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});

describe("ensureFreshTikTokToken", () => {
  const refreshOk = () =>
    vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "fresh-access-token", expires_in: 86_400 }),
    );

  it("returns the same connection without any refresh when expiresAt is null (cannot judge)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const connection = makeConnection({ expiresAt: null });

    await expect(ensureFreshTikTokToken(connection)).resolves.toBe(connection);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the same connection when the token has more than 5 minutes left", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 10 * 60 * 1000) });

    await expect(ensureFreshTikTokToken(connection)).resolves.toBe(connection);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when the token expires within 5 minutes", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 4 * 60 * 1000) });

    const result = await ensureFreshTikTokToken(connection);

    expect(result.accessToken).toBe("fresh-access-token");
    expect(updateCalls()).toHaveLength(1);
  });

  it("refreshes when the token is already expired", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const connection = makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    const result = await ensureFreshTikTokToken(connection);

    expect(result.accessToken).toBe("fresh-access-token");
  });

  it("propagates a terminal refresh failure as the reconnect error (flagged exactly once)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)));
    const connection = makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    const error = await caught(ensureFreshTikTokToken(connection));

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
  });

  it("propagates a transient refresh failure as-is, unflagged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const connection = makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    const error = await caught(ensureFreshTikTokToken(connection));

    expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
    expect(error?.status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // 2026-11-01 scale audit (jobs, token refresh): the refresh is serialized per
  // connection by refreshConnectionToken (connectionRefresh.ts).
  it("routes the refresh through refreshConnectionToken with the snapshot and the step deadline", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const connection = makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });
    const deadline = Date.now() + 60_000;

    await ensureFreshTikTokToken(connection, deadline);

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0]).toBe(connection);
    expect(refreshConnectionTokenMock.mock.calls[0][2]).toEqual({ deadline });
  });

  it("does not take the lock for a token that is still fresh", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 10 * 60 * 1000) });

    await ensureFreshTikTokToken(connection);

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("returns whatever the lock hands back (another process's refresh), without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const winner = makeConnection({ accessToken: "winner-access", refreshToken: "winner-refresh" });
    refreshConnectionTokenMock.mockResolvedValue(winner);

    const result = await ensureFreshTikTokToken(
      makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") }),
    );

    expect(result).toBe(winner);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (step budget, Task 7): a refresh that runs inside a
// platform step (or inside Task 8's per-connection lock) must not push the step
// past its deadline, so its request is clamped to the time left and is never
// started with under 5 s left.
describe("TikTok token refresh — step deadline", () => {
  const NOW = Date.parse("2026-11-01T12:00:00Z");
  const expired = () => makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });
  const refreshOk = () =>
    vi.fn().mockResolvedValue(jsonResponse({ access_token: "fresh-access-token", expires_in: 86_400 }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("refreshTikTokToken clamps the token request to the time left (a deadline 8 s away -> <= 8 s)", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await refreshTikTokToken(makeConnection(), { deadline: NOW + 8_000 });

    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
    expect(timeouts[0]).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
  });

  it("refreshTikTokToken keeps the 30 s default without a deadline", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await refreshTikTokToken(makeConnection());

    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([30_000]);
  });

  it("refreshTikTokToken refuses to start with under 5 s left: no request, no write, no reconnect flag", async () => {
    const fetchMock = refreshOk();
    vi.stubGlobal("fetch", fetchMock);

    const error = await caught(refreshTikTokToken(makeConnection(), { deadline: NOW + MIN_REQUEST_WINDOW_MS - 1 }));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ensureFreshTikTokToken passes its deadline to the refresh (8 s away -> request <= 8 s)", async () => {
    vi.stubGlobal("fetch", refreshOk());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const refreshed = await ensureFreshTikTokToken(expired(), NOW + 8_000);

    expect(refreshed.accessToken).toBe("fresh-access-token");
    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
  });

  it("ensureFreshTikTokToken refuses to refresh with under 5 s left", async () => {
    const fetchMock = refreshOk();
    vi.stubGlobal("fetch", fetchMock);

    const error = await caught(ensureFreshTikTokToken(expired(), NOW + MIN_REQUEST_WINDOW_MS - 1));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ensureFreshTikTokToken leaves a fresh token alone even with the budget spent", async () => {
    const fetchMock = refreshOk();
    vi.stubGlobal("fetch", fetchMock);
    const fresh = makeConnection({ expiresAt: new Date(NOW + 3_600_000) });

    await expect(ensureFreshTikTokToken(fresh, NOW - 1)).resolves.toBe(fresh);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishVideo passes the step deadline to the refresh of an expired token (under 5 s left -> no request)", async () => {
    const fetchMock = refreshOk();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      user: { id: "user-1" },
      socialConnection: expired(),
      mediaItem: {
        id: "media-1",
        mimeType: "video/mp4",
        originalFilename: "clip.mp4",
        storageLocation: "https://blob.example.com/clip.mp4",
      },
      caption: "hi",
      deadline: NOW + MIN_REQUEST_WINDOW_MS - 1,
    } as unknown as PublishContext;

    const error = await caught(tiktokClient.publishVideo(ctx));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("tiktokClient.refreshToken (connection-health sweep wiring)", () => {
  it("exposes refreshToken so the daily sweep (which skips clients without one) refreshes TikTok", () => {
    expect(typeof tiktokClient.refreshToken).toBe("function");
  });

  it("refreshes through the same implementation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ access_token: "swept", expires_in: 86_400 })),
    );

    const result = await tiktokClient.refreshToken!(makeConnection());

    expect(result.accessToken).toBe("swept");
  });
});

describe("tiktokClient.publishVideo", () => {
  const mediaItem = {
    id: "media-1",
    mimeType: "video/mp4",
    originalFilename: "clip.mp4",
    storageLocation: "https://blob.example.com/clip.mp4",
  } as unknown as MediaItem;

  function makeCtx(connection: SocialConnection = makeConnection()): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: connection,
      get mediaItems() { return [this.mediaItem]; },
      mediaItem,
      caption: "hello",
      tiktokMetadata: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true },
    };
  }

  /** Route a stubbed fetch by URL; unmatched URLs fail the test loudly. */
  function stubFetch(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      const route = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      if (!route) throw new Error(`Unexpected fetch in test: ${url}`);
      return Promise.resolve(route[1]());
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const creatorInfoOk = () =>
    jsonResponse({ data: { creator_username: "acme", privacy_level_options: ["SELF_ONLY"] } });
  const videoBlob = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  const initOk = () =>
    jsonResponse({
      data: { publish_id: "publish-123", upload_url: "https://upload.tiktok.example/u" },
      error: { code: "ok" },
    });
  const uploadOk = () => new Response("", { status: 201 });

  it("completes (no timeout failure) when TikTok reports the real uppercase PUBLISH_COMPLETE", async () => {
    vi.useFakeTimers();
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": initOk,
      "upload.tiktok.example": uploadOk,
      "status/fetch": () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
    });

    const promise = tiktokClient.publishVideo(makeCtx());
    await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

    await expect(promise).resolves.toEqual({ externalPostId: "publish-123" });
  });

  it("refreshes an expiring token BEFORE any TikTok API call and uses the new token", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({
      "oauth/token": () => jsonResponse({ access_token: "fresh-access-token", expires_in: 86_400 }),
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": initOk,
      "upload.tiktok.example": uploadOk,
      "status/fetch": () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
    });

    const promise = tiktokClient.publishVideo(
      makeCtx(makeConnection({ expiresAt: new Date(Date.now() + 60 * 1000) })),
    );
    await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);
    await promise;

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("oauth/token");
    const creatorCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("creator_info"))!;
    expect(((creatorCall[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-access-token",
    );
  });

  it("does not call TikTok at all and surfaces the reconnect code when the refresh is terminal", async () => {
    const fetchMock = stubFetch({
      "oauth/token": () => jsonResponse({ error: "invalid_grant" }, 400),
    });

    const error = await caught(
      tiktokClient.publishVideo(
        makeCtx(makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") })),
      ),
    );

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
  });

  it("maps a 401 from creator_info to TIKTOK_RECONNECT_REQUIRED and flags the connection", async () => {
    stubFetch({
      "creator_info/query": () =>
        jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401),
    });

    const error = await caught(tiktokClient.publishVideo(makeCtx(makeConnection({ id: "conn-7" }))));

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(error?.message).toMatch(/reconnect/i);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].where).toEqual({ id: "conn-7" });
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
    expect(updateCalls()[0].data.lastRefreshErrorCode).toBe(RECONNECT_CODE);
    expect(updateCalls()[0].data).not.toHaveProperty("accessToken");
    expect(updateCalls()[0].data).not.toHaveProperty("refreshToken");
  });

  // 2026-11-02 scale audit: the flag is guarded by the tokens the rejected
  // call used. If another process rotated them meanwhile, nothing is flagged and
  // the call fails with a plain, retryable CONNECTION_TOKEN_CHANGED.
  describe("a rejected token whose stored tokens changed meanwhile", () => {
    const rotated = { accessToken: "rotated-access", refreshToken: "rotated-refresh" };

    it("creator_info 401: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      findUniqueMock.mockResolvedValue(rotated);
      stubFetch({
        "creator_info/query": () =>
          jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateCalls()).toHaveLength(0);
    });

    it("video/init 401: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      findUniqueMock.mockResolvedValue(rotated);
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": () =>
          jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateCalls()).toHaveLength(0);
    });

    it("video/init body access_token_invalid: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      findUniqueMock.mockResolvedValue(rotated);
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": () =>
          jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 200),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateCalls()).toHaveLength(0);
    });

    it("the guard re-reads the tokens this call used (the refreshed connection, not the stale ctx row)", async () => {
      // The pre-publish refresh persisted new tokens; the guard must compare with those.
      const refreshed = makeConnection({
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
      });
      refreshConnectionTokenMock.mockResolvedValue(refreshed);
      findUniqueMock.mockResolvedValue({
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
      });
      stubFetch({
        "creator_info/query": () =>
          jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401),
      });

      const error = await caught(
        tiktokClient.publishVideo(
          makeCtx(makeConnection({ expiresAt: new Date(Date.now() + 60 * 1000) })),
        ),
      );

      expect(error?.code).toBe(RECONNECT_CODE);
      expect(updateCalls()).toHaveLength(1);
    });
  });

  it("maps a 401 from video/init to TIKTOK_RECONNECT_REQUIRED and flags the connection", async () => {
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": () =>
        jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401),
    });

    const error = await caught(tiktokClient.publishVideo(makeCtx()));

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
  });

  it("maps an access_token_invalid error code inside a 200 init response to the reconnect code too", async () => {
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": () =>
        jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 200),
    });

    const error = await caught(tiktokClient.publishVideo(makeCtx()));

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(updateCalls()).toHaveLength(1);
  });

  it("does NOT flag the connection for non-auth init failures", async () => {
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": () => jsonResponse({ error: { code: "internal_error" } }, 500),
    });

    const error = await caught(tiktokClient.publishVideo(makeCtx()));

    expect(error?.code).toBe("TIKTOK_INIT_FAILED");
    expect(updateMock).not.toHaveBeenCalled();
  });

  // Until the Direct Post audit passes, TikTok refuses posts to public accounts.
  // The user gets a plain explanation, not "Failed to start TikTok video upload".
  it.each([
    ["an error status", 403],
    ["a 200 response", 200],
  ])("explains TikTok's unaudited-app refusal (in %s) as TIKTOK_PUBLIC_ACCOUNT_NOT_ALLOWED", async (_label, status) => {
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": () =>
        jsonResponse(
          { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "Please review our integration guidelines" } },
          status,
        ),
    });

    const error = await caught(tiktokClient.publishVideo(makeCtx()));

    expect(error?.code).toBe("TIKTOK_PUBLIC_ACCOUNT_NOT_ALLOWED");
    expect(error?.message).toBe(TIKTOK_PUBLIC_ACCOUNT_NOT_ALLOWED_MESSAGE);
    expect(updateMock).not.toHaveBeenCalled(); // not a reconnect problem
  });

  // Task 4 item 10 — step budget.
  it("refuses to start once the step budget is spent (no TikTok call, nothing posted)", async () => {
    const fetchMock = stubFetch({});

    const error = await caught(
      tiktokClient.publishVideo({ ...makeCtx(), deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1 }),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("worst case: a slow download + upload and a video that never finishes processing still end by the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    /** Resolve after `ms` of (fake) time — or reject if the request is aborted first. */
    const slow = (ms: number, make: () => Response) => (init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(make()), ms);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const routes: Record<string, (init?: RequestInit) => Promise<Response>> = {
      "creator_info/query": async () => creatorInfoOk(),
      "blob.example.com": slow(110_000, videoBlob),
      "video/init": async () => initOk(),
      "upload.tiktok.example": slow(40_000, uploadOk),
      "status/fetch": async () => jsonResponse({ data: { status: "PROCESSING_UPLOAD" } }),
    };
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const route = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      if (!route) throw new Error(`Unexpected fetch in test: ${url}`);
      return route[1](init);
    });
    vi.stubGlobal("fetch", fetchMock);

    let settledAt = 0;
    const promise = caught(tiktokClient.publishVideo({ ...makeCtx(), deadline })).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(400_000);
    const error = await promise;

    // Polling began ~150s in; unbounded, 24 x 5s would have run to ~270s.
    expect(error?.code).toBe("TIKTOK_PUBLISH_PENDING");
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });

  it("an in-step retry reuses the token the first attempt refreshed (never re-spends a rotated refresh token)", async () => {
    vi.useFakeTimers();
    let downloads = 0;
    const fetchMock = stubFetch({
      "oauth/token": () =>
        jsonResponse({ access_token: "fresh-access-token", refresh_token: "rotated-refresh", expires_in: 86_400 }),
      "creator_info/query": creatorInfoOk,
      // Attempt 1 refreshes, then hits a retryable 503 (before anything is
      // posted); withTransientRetries re-runs publishVideo with the same ctx.
      "blob.example.com": () =>
        ++downloads === 1 ? new Response("unavailable", { status: 503 }) : videoBlob(),
      "video/init": initOk,
      "upload.tiktok.example": uploadOk,
      "status/fetch": () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
    });
    const ctx = makeCtx(makeConnection({ expiresAt: new Date(Date.now() + 60 * 1000) }));

    const promise = withTransientRetries(() => tiktokClient.publishVideo(ctx), {
      sleep: async () => {},
    });
    await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

    await expect(promise).resolves.toEqual({ externalPostId: "publish-123" });
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    const creatorCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("creator_info"));
    expect(creatorCalls).toHaveLength(2);
    expect(
      ((creatorCalls[1][1] as RequestInit).headers as Record<string, string>).Authorization,
    ).toBe("Bearer fresh-access-token");
  });

  // The final chunk already went up, so TikTok may be posting: a 401 from the
  // status poll is PUBLISH_UNCONFIRMED (never a reconnect-and-retry), whether or
  // not the connection could be flagged (2026-11-02 scale audit).
  it("maps a 401 from the status poll to PUBLISH_UNCONFIRMED mid-publish, and flags the connection", async () => {
    vi.useFakeTimers();
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": initOk,
      "upload.tiktok.example": uploadOk,
      "status/fetch": () => jsonResponse({ error: { code: "access_token_invalid" } }, 401),
    });

    const promise = caught(tiktokClient.publishVideo(makeCtx()));
    await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

    const error = await promise;
    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
  });

  it("a 401 from the status poll with changed tokens is still PUBLISH_UNCONFIRMED and flags nothing", async () => {
    vi.useFakeTimers();
    findUniqueMock.mockResolvedValue({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    stubFetch({
      "creator_info/query": creatorInfoOk,
      "blob.example.com": videoBlob,
      "video/init": initOk,
      "upload.tiktok.example": uploadOk,
      "status/fetch": () => jsonResponse({ error: { code: "access_token_invalid" } }, 401),
    });

    const promise = caught(tiktokClient.publishVideo(makeCtx()));
    await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

    const error = await promise;
    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(updateCalls()).toHaveLength(0);
  });

  // 2026-11-01 scale audit (platform limits, V14): TikTok's rate_limit_exceeded
  // is an HTTP 429 and also arrives as `error.code` in a body. Both become
  // RATE_LIMITED; the publish-status poll (which absorbs errors by design) is
  // not classified.
  describe("rate limits (RATE_LIMITED)", () => {
    it("classifies a creator_info 429 (Retry-After) as RATE_LIMITED, keeping kind and retryAt", async () => {
      stubFetch({
        "creator_info/query": () =>
          new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      });

      const error = (await caught(tiktokClient.publishVideo(makeCtx()))) as CodedError & {
        kind?: string;
        platform?: string;
        retryAt?: number | null;
      };

      expect(error?.code).toBe("RATE_LIMITED");
      expect(error?.platform).toBe("tiktok");
      expect(error?.kind).toBe("rate_limited");
      expect(error?.retryAt).toBeGreaterThan(Date.now());
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("video/init 429 -> RATE_LIMITED, not TIKTOK_INIT_FAILED", async () => {
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": () => jsonResponse({ error: { code: "rate_limit_exceeded" } }, 429),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("RATE_LIMITED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("video/init 200 whose body error.code is rate_limit_exceeded -> RATE_LIMITED, not TIKTOK_INIT_ERROR", async () => {
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": () =>
          jsonResponse({ error: { code: "rate_limit_exceeded", message: "slow down", log_id: "L" } }, 200),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("RATE_LIMITED");
    });

    it("a chunk PUT 429 -> RATE_LIMITED, not TIKTOK_UPLOAD_FAILED", async () => {
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": initOk,
        "upload.tiktok.example": () => new Response("", { status: 429 }),
      });

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("RATE_LIMITED");
    });

    // A 2xx on the final chunk may mean TikTok took the upload and is posting: only the status
    // poll can say, so a rate-limit code in that body is not a rate limit (a deferral would
    // upload the video again: a second post).
    it("a 2xx final chunk PUT whose body says rate_limit_exceeded goes on to the status poll, never RATE_LIMITED", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": initOk,
        "upload.tiktok.example": () => jsonResponse({ error: { code: "rate_limit_exceeded" } }, 201),
        "status/fetch": () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
      });

      const promise = tiktokClient.publishVideo(makeCtx());
      await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

      await expect(promise).resolves.toEqual({ externalPostId: "publish-123" });
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("status/fetch"))).toHaveLength(1);
    });

    it("is not retried in-step", async () => {
      const fetchMock = stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": () => jsonResponse({ error: { code: "rate_limit_exceeded" } }, 429),
      });

      const error = await caught(
        withTransientRetries(() => tiktokClient.publishVideo(makeCtx()), { sleep: async () => {} }),
      );

      expect(error?.code).toBe("RATE_LIMITED");
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("video/init"))).toHaveLength(1);
    });

    it("leaves the status poll untouched: a 429 there is absorbed and polling continues", async () => {
      vi.useFakeTimers();
      const statuses = [
        () => new Response("", { status: 429 }),
        () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
      ];
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": initOk,
        "upload.tiktok.example": uploadOk,
        "status/fetch": () => (statuses.shift() ?? statuses[0])(),
      });

      const promise = tiktokClient.publishVideo(makeCtx());
      await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS * 2);

      await expect(promise).resolves.toEqual({ externalPostId: "publish-123" });
    });

    it("leaves the token endpoint untouched: a refresh 429 keeps TIKTOK_TOKEN_REFRESH_FAILED and its status", async () => {
      stubFetch({ "oauth/token": () => jsonResponse({ error: "rate_limited" }, 429) });

      const error = await caught(
        tiktokClient.publishVideo(
          makeCtx(makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") })),
        ),
      );

      expect(error?.code).toBe("TIKTOK_TOKEN_REFRESH_FAILED");
      expect(error?.status).toBe(429);
    });
  });

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): Direct Post publishes as
  // soon as the upload completes, so only the FINAL chunk PUT is the commit
  // call. A 5xx / timeout / dropped connection there is PUBLISH_UNCONFIRMED and
  // is never re-run; earlier chunks publish nothing and stay retryable.
  describe("commit call (the final chunk PUT)", () => {
    /** 30 MB: three 10 MB chunks (computeChunkPlan floors size / chunk size). */
    const video30Mb = () => new Response(new Uint8Array(30 * MB), { status: 200 });
    const chunkPuts = (fetchMock: ReturnType<typeof stubFetch>) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("upload.tiktok.example"));
    const urlCalls = (fetchMock: ReturnType<typeof stubFetch>, fragment: string) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));

    /** Routes for a three-chunk upload; `put(n)` answers the n-th chunk PUT (1-based). */
    function stubThreeChunks(put: (n: number) => Response) {
      let puts = 0;
      return stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": video30Mb,
        "video/init": initOk,
        "upload.tiktok.example": () => put(++puts),
        "status/fetch": () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } }),
      });
    }

    it("sanity: the 30 MB video is three chunks", () => {
      expect(computeChunkPlan(30 * MB).totalChunks).toBe(3);
    });

    it("a 503 on chunk 1 of 3 -> TIKTOK_UPLOAD_FAILED with status 503 (still retryable), uploading no further", async () => {
      const fetchMock = stubThreeChunks((n) => (n === 1 ? new Response("busy", { status: 503 }) : uploadOk()));

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("TIKTOK_UPLOAD_FAILED");
      expect(error?.status).toBe(503);
      expect(isTransientPublishError(error)).toBe(true);
      expect(chunkPuts(fetchMock)).toHaveLength(1);
    });

    it("a 503 on a middle chunk (2 of 3) is equally retryable", async () => {
      stubThreeChunks((n) => (n === 2 ? new Response("busy", { status: 503 }) : uploadOk()));

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("TIKTOK_UPLOAD_FAILED");
      expect(error?.status).toBe(503);
    });

    it("a 503 on the final chunk -> PUBLISH_UNCONFIRMED, without polling", async () => {
      const fetchMock = stubThreeChunks((n) => (n === 3 ? new Response("busy", { status: 503 }) : uploadOk()));

      const error = await caught(tiktokClient.publishVideo(makeCtx()));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(isTransientPublishError(error)).toBe(false);
      expect(chunkPuts(fetchMock)).toHaveLength(3);
      expect(urlCalls(fetchMock, "status/fetch")).toHaveLength(0);
    });

    it("a 503 on the final chunk is not re-run by the in-step retry: one init, three PUTs", async () => {
      const fetchMock = stubThreeChunks((n) => (n === 3 ? new Response("busy", { status: 503 }) : uploadOk()));

      const error = await caught(
        withTransientRetries(() => tiktokClient.publishVideo(makeCtx()), { sleep: async () => {} }),
      );

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(urlCalls(fetchMock, "video/init")).toHaveLength(1);
      expect(chunkPuts(fetchMock)).toHaveLength(3);
    });

    it("a single-chunk upload's only PUT is the final chunk: a 503 there -> PUBLISH_UNCONFIRMED", async () => {
      stubFetch({
        "creator_info/query": creatorInfoOk,
        "blob.example.com": videoBlob,
        "video/init": initOk,
        "upload.tiktok.example": () => new Response("busy", { status: 503 }),
      });

      expect((await caught(tiktokClient.publishVideo(makeCtx())))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a connection dropped after the final chunk was sent -> PUBLISH_UNCONFIRMED", async () => {
      stubThreeChunks((n) => {
        if (n === 3) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        return uploadOk();
      });

      expect((await caught(tiktokClient.publishVideo(makeCtx())))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a timeout on the final chunk -> PUBLISH_UNCONFIRMED", async () => {
      stubThreeChunks((n) => {
        if (n === 3) throw Object.assign(new Error("Request timed out after 120000ms"), { code: "FETCH_TIMEOUT" });
        return uploadOk();
      });

      expect((await caught(tiktokClient.publishVideo(makeCtx())))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a final chunk that never connected is rethrown unchanged (provably not sent)", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubThreeChunks((n) => {
        if (n === 3) throw neverConnected;
        return uploadOk();
      });

      expect(await caught(tiktokClient.publishVideo(makeCtx()))).toBe(neverConnected);
    });

    it("a 2xx on an earlier chunk is never a rate limit, whatever its body says: the upload carries on", async () => {
      vi.useFakeTimers();
      const fetchMock = stubThreeChunks((n) =>
        n === 1 ? jsonResponse({ error: { code: "rate_limit_exceeded" } }, 206) : uploadOk(),
      );

      const promise = tiktokClient.publishVideo(makeCtx());
      await vi.advanceTimersByTimeAsync(TIKTOK_POLL_INTERVAL_MS);

      await expect(promise).resolves.toEqual({ externalPostId: "publish-123" });
      expect(chunkPuts(fetchMock)).toHaveLength(3);
    });

    it("a final chunk 429 is still RATE_LIMITED, and a 400 still TIKTOK_UPLOAD_FAILED", async () => {
      stubThreeChunks((n) => (n === 3 ? new Response("", { status: 429 }) : uploadOk()));
      expect((await caught(tiktokClient.publishVideo(makeCtx())))?.code).toBe("RATE_LIMITED");

      stubThreeChunks((n) => (n === 3 ? new Response("bad", { status: 400 }) : uploadOk()));
      const error = await caught(tiktokClient.publishVideo(makeCtx()));
      expect(error?.code).toBe("TIKTOK_UPLOAD_FAILED");
      expect(error?.status).toBe(400);
    });

    it("a budget spent before the final chunk -> PUBLISH_TIME_BUDGET_EXCEEDED, not unconfirmed, nothing sent", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
      const start = Date.now();
      const fetchMock = stubThreeChunks((n) => {
        // Chunk 2 "takes" long enough that less than the minimum request window is left.
        if (n === 2) vi.setSystemTime(start + 100_000 - MIN_REQUEST_WINDOW_MS + 1);
        return uploadOk();
      });

      const error = await caught(tiktokClient.publishVideo({ ...makeCtx(), deadline: start + 100_000 }));

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(chunkPuts(fetchMock)).toHaveLength(2);
    });
  });
});

// 2026-11-02 scale audit (jobs B3): a video above 50 MiB on an enabled platform is read from
// storage 10 MiB at a time and PUT to TikTok's upload_url across steps. Every request is faked;
// the video is a lazily generated stream (never 60 MiB at once on this path), and the upload
// state is an in-memory store with the real store's rules (a kind, a readable `data` that holds
// no URL, a sealed `secret`).
describe("tiktokClient.publishVideo — streamed FILE_UPLOAD (jobs B3)", () => {
  const MIB = 1024 * 1024;
  const CHUNK = TIKTOK_MAX_CHUNK_SIZE;
  /** 60 MiB + 5 bytes: six chunks; the last one absorbs the 5 trailing bytes. */
  const TOTAL = 6 * CHUNK + 5;
  const TOTAL_CHUNKS = 6;
  const FINAL_START = 5 * CHUNK;
  const NOW = Date.parse("2026-11-02T10:00:00.000Z");
  const STEP = PUBLISH_STEP_BUDGET_MS;

  const uploadUrlOf = (n: number) => `https://open-upload.tiktokapis.example/video/?upload_id=SECRET-${n}&upload_token=TOKEN-${n}`;
  const URL_1 = uploadUrlOf(1);
  const URL_2 = uploadUrlOf(2);

  type Req = { url: string; init: RequestInit };
  type Reply = (req: Req) => Response | Promise<Response>;

  const mediaItemOf = (sizeBytes: number) =>
    ({
      id: "media-1",
      mimeType: "video/mp4",
      originalFilename: "clip.mp4",
      storageLocation: "https://blob.example.com/clip.mp4",
      sizeBytes,
    }) as unknown as MediaItem;

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
  const timeout = () => failWith(Object.assign(new Error("Request timed out after 120000ms"), { code: "FETCH_TIMEOUT" }));
  const connectionReset = () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));

  const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
  const contentRange = (call: Parameters<typeof fetch> | undefined) => headersOf(call?.[1])["Content-Range"];
  const bodyOf = (call: Parameters<typeof fetch> | undefined) => (call?.[1] as RequestInit).body as Buffer;

  const creatorInfoOk: Reply = () =>
    jsonResponse({
      data: {
        creator_username: "acme",
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      },
    });
  const initOk =
    (n: number): Reply =>
    () =>
      jsonResponse({ data: { publish_id: `publish-${n}`, upload_url: uploadUrlOf(n) }, error: { code: "ok" } });
  const statusComplete: Reply = () => jsonResponse({ data: { status: "PUBLISH_COMPLETE" } });

  /** Accepts a chunk the way TikTok does: 206 while more remain, 201 for the last one. */
  const acceptChunk: Reply = ({ init }) => {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headersOf(init)["Content-Range"] ?? "");
    if (!match) throw new Error(`Not a chunk request: ${headersOf(init)["Content-Range"]}`);
    return new Response(null, { status: Number(match[2]) + 1 >= Number(match[3]) ? 201 : 206 });
  };
  const accepts = (count: number): Reply[] => Array.from({ length: count }, () => acceptChunk);
  const resyncAt = (answer: string): Reply => reply(416, null, { "Content-Range": answer });

  /** The clock moves while a request is in flight. */
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const after =
    (ms: number, next: Reply): Reply =>
    (req) => {
      advance(ms);
      return next(req);
    };

  /**
   * Fakes creator_info, video/init, the status poll, the blob and the upload URL. `init` and
   * `puts` are the scripts of answers, in order (every chunk PUT, whatever URL it goes to).
   */
  function stubTikTok(
    opts: {
      total?: number;
      creator?: Reply;
      init?: Reply[];
      puts?: Reply[];
      status?: Reply;
      blobStatus?: number;
      /** The first N blob reads fail with a 503. */
      blobFailures?: number;
      blobAdvance?: number;
      blobClaimsTotal?: number;
    } = {},
  ) {
    const total = opts.total ?? TOTAL;
    const inits = [...(opts.init ?? [initOk(1)])];
    const puts = [...(opts.puts ?? [])];
    let blobFailures = opts.blobFailures ?? 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const req = { url, init: init ?? {} };
      if (url.includes("blob.example.com")) {
        const range = /^bytes=(\d+)-$/.exec(headersOf(init)["Range"] ?? "");
        const start = range ? Number(range[1]) : 0;
        if (blobFailures > 0) {
          blobFailures -= 1;
          return new Response(null, { status: 503 });
        }
        if (opts.blobStatus !== undefined) return new Response(null, { status: opts.blobStatus });
        if (opts.blobAdvance !== undefined) advance(opts.blobAdvance); // a slow blob read
        const claimed = opts.blobClaimsTotal ?? total;
        return range
          ? new Response(lazyBlobBody(start, total), {
              status: 206,
              headers: { "Content-Range": `bytes ${start}-${claimed - 1}/${claimed}` },
            })
          : new Response(lazyBlobBody(0, total), { status: 200, headers: { "Content-Length": String(claimed) } });
      }
      if (url.includes("creator_info/query")) return (opts.creator ?? creatorInfoOk)(req);
      if (url.includes("video/init")) {
        const next = inits.shift();
        if (!next) throw new Error("Unexpected extra video/init in test");
        return next(req);
      }
      if (url.includes("status/fetch")) return (opts.status ?? statusComplete)(req);
      if (url.includes("upload_id=")) {
        const next = puts.shift();
        if (!next) throw new Error(`Unexpected extra chunk PUT in test: ${headersOf(init)["Content-Range"]}`);
        return next(req);
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const callsTo = (fragment: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));
    return {
      fetchMock,
      creatorInfoCalls: () => callsTo("creator_info/query"),
      inits: () => callsTo("video/init"),
      polls: () => callsTo("status/fetch"),
      blobGets: () => callsTo("blob.example.com"),
      /** Every chunk PUT, to whichever upload URL. */
      puts: () => callsTo("upload_id="),
      putsTo: (n: number) => callsTo(`upload_id=SECRET-${n}`),
    };
  }

  /** An in-memory store with the real store's rules: a kind, a readable `data` that holds no URL, a secret. */
  function fakeStore(initial?: { data: unknown; secret?: unknown }) {
    let current: { kind: string; data: unknown; secret?: unknown } | null = initial
      ? { kind: TIKTOK_UPLOAD_STATE_KIND, ...initial }
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

  type StateData = {
    publishId: string;
    initAt: number;
    size: number;
    chunkSize: number;
    totalChunks: number;
    nextChunk: number;
  };

  /** A saved upload that has `nextChunk` chunks behind it, started at `NOW` on `url`. */
  const stateAt = (nextChunk: number, over: Partial<StateData> = {}, url = URL_1) => ({
    data: {
      publishId: "publish-1",
      initAt: NOW,
      size: TOTAL,
      chunkSize: CHUNK,
      totalChunks: TOTAL_CHUNKS,
      nextChunk,
      ...over,
    } satisfies StateData,
    secret: { uploadUrl: url },
  });

  function bigCtx(
    store: UploadStateStore | undefined,
    overrides: Partial<PublishContext> = {},
    sizeBytes = TOTAL,
  ): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection(),
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: mediaItemOf(sizeBytes),
      caption: "hello",
      tiktokMetadata: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true },
      uploadState: store,
      ...overrides,
    };
  }

  const run = (ctx: PublishContext) => tiktokClient.publishVideo(ctx);
  const failure = (ctx: PublishContext) => caught(run(ctx));
  /** Out of step time: the next step starts at once. */
  const paused = { continuation: { resumeAt: null } };
  /** A failure that says nothing about the upload: the next step starts `ms` from now. */
  const pausedFor = (ms: number) => ({ continuation: { resumeAt: Date.now() + ms } });
  const TRANSIENT_RESUME_DELAY = 30_000;

  /** The `[first, last]` of every chunk PUT, in order. */
  const rangesOf = (calls: Array<Parameters<typeof fetch>>) =>
    calls.map((c) => {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange(c) ?? "");
      return [Number(match![1]), Number(match![2])] as const;
    });

  /** The sampled bytes of a chunk PUT's body are the video's bytes from `first`. */
  function expectBodyFrom(call: Parameters<typeof fetch> | undefined, first: number) {
    const body = bodyOf(call);
    for (const at of [0, 1, Math.floor(body.length / 2), body.length - 1]) {
      expect(body[at]).toBe(byteAt(first + at));
    }
  }

  /** Every console call of the test (the logger writes through console), as one string. */
  const everythingLogged = () =>
    JSON.stringify(
      (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.mocked(console[level]).mock.calls),
    );

  const describeError = (error: unknown) => {
    const e = error as (Error & { code?: string; status?: number; cause?: unknown }) | null;
    return JSON.stringify({ name: e?.name, message: e?.message, stack: e?.stack, code: e?.code, status: e?.status, cause: String(e?.cause) });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "tiktok");
    streams.opened = 0;
    streams.cancelled = 0;
    for (const level of ["info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    // The status poll waits 5 s between checks; the clock is fake, so make that wait instant.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) =>
      realSetTimeout(handler, ms === TIKTOK_POLL_INTERVAL_MS ? 0 : ms, ...args)) as unknown as typeof setTimeout);
  });

  it("pins the vendor values and the saved-state kind", () => {
    expect(TIKTOK_UPLOAD_STATE_KIND).toBe("tiktok_file_upload");
    expect(TIKTOK_UPLOAD_URL_TTL_MS).toBe(3_600_000);
    expect(TIKTOK_UPLOAD_URL_SAFETY_MS).toBe(600_000);
    expect(TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS).toBe(150_000);
    expect(TIKTOK_TRANSIENT_RESUME_DELAY_MS).toBe(TRANSIENT_RESUME_DELAY);
    expect(TIKTOK_MAX_CHUNK_SIZE).toBe(10 * MIB);
    expect(TOTAL).toBeGreaterThan(LARGE_VIDEO_THRESHOLD_BYTES);
    expect(computeChunkPlan(TOTAL).totalChunks).toBe(TOTAL_CHUNKS);
  });

  /** The whole-file path's requests: a 4-byte blob served without a Range, and a one-chunk upload. */
  function stubSmallPath() {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("creator_info")) return creatorInfoOk({ url, init: {} });
      if (url.includes("blob.example.com")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      if (url.includes("video/init")) return initOk(1)({ url, init: {} });
      if (url.includes("upload_id=")) return new Response(null, { status: 201 });
      return statusComplete({ url, init: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const blobCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("blob.example.com"));
    return { fetchMock, blobCalls };
  }

  describe("which path a post takes", () => {
    it("keeps today's whole-file download when TikTok is not enabled (the default)", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "");
      const { store, mocks } = fakeStore();
      const small = stubSmallPath();

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(small.blobCalls()).toHaveLength(1);
      expect(headersOf(small.blobCalls()[0][1])["Range"]).toBeUndefined();
    });

    it("keeps today's path for a video at or below 50 MiB, and for a direct caller with no store", async () => {
      const { store, mocks } = fakeStore();
      const small = stubSmallPath();

      await run(bigCtx(store, {}, LARGE_VIDEO_THRESHOLD_BYTES));
      await run(bigCtx(undefined));

      expect(mocks.save).not.toHaveBeenCalled();
      expect(small.blobCalls()).toHaveLength(2);
      for (const call of small.blobCalls()) expect(headersOf(call[1])["Range"]).toBeUndefined();
    });

    it("takes the streamed path for a video above 50 MiB when TikTok is enabled: a Range read, never a whole download", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      await run(bigCtx(store));

      expect(upload.blobGets()).toHaveLength(1);
      expect(headersOf(upload.blobGets()[0][1])["Range"]).toBe("bytes=0-");
    });

    it("an upload that already has saved state stays on the streamed path even after the switch is turned off", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "none");
      const { store } = fakeStore(stateAt(4));
      const upload = stubTikTok({ puts: accepts(2) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(upload.puts()).toHaveLength(2);
    });

    it("another platform's switch does not enable TikTok", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "youtube,x");
      const { store, mocks } = fakeStore();
      const small = stubSmallPath();

      await run(bigCtx(store));

      expect(mocks.save).not.toHaveBeenCalled();
      expect(headersOf(small.blobCalls()[0][1])["Range"]).toBeUndefined();
    });
  });

  describe("the first step", () => {
    it("runs creator_info and video/init once, with the 10 MiB chunk plan, and sends the same post_info as the small path", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      await run(
        bigCtx(store, {
          caption: "Holiday #sun",
          tiktokMetadata: { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: true, disableDuet: false, disableStitch: true },
        }),
      );

      expect(upload.creatorInfoCalls()).toHaveLength(1);
      expect(upload.inits()).toHaveLength(1);
      const body = JSON.parse((upload.inits()[0][1] as RequestInit).body as string);
      expect(body.source_info).toEqual({
        source: "FILE_UPLOAD",
        video_size: TOTAL,
        chunk_size: CHUNK,
        total_chunk_count: TOTAL_CHUNKS,
      });
      expect(body.post_info).toEqual({
        title: "Holiday #sun",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: true,
        disable_duet: false,
        disable_stitch: true,
        video_cover_timestamp_ms: 1000,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      });
    });

    it("saves the upload at once - the upload_url sealed in `secret`, progress in `data` - before the first chunk is sent", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      await run(bigCtx(store));

      expect(mocks.load).toHaveBeenCalledWith("tiktok_file_upload");
      expect(mocks.save.mock.calls[0]).toEqual([
        "tiktok_file_upload",
        {
          data: {
            publishId: "publish-1",
            initAt: NOW,
            size: TOTAL,
            chunkSize: CHUNK,
            totalChunks: TOTAL_CHUNKS,
            nextChunk: 0,
          },
          secret: { uploadUrl: URL_1 },
        },
      ]);
      const saveOrder = mocks.save.mock.invocationCallOrder[0];
      const initIndex = upload.fetchMock.mock.calls.indexOf(upload.inits()[0]);
      const firstPut = upload.fetchMock.mock.calls.indexOf(upload.puts()[0]);
      expect(saveOrder).toBeGreaterThan(upload.fetchMock.mock.invocationCallOrder[initIndex]);
      expect(saveOrder).toBeLessThan(upload.fetchMock.mock.invocationCallOrder[firstPut]);
    });

    it("sends each chunk with its Content-Range and Content-Type, the video's own bytes, the last absorbing the remainder", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      await run(bigCtx(store));

      const puts = upload.puts();
      expect(puts).toHaveLength(TOTAL_CHUNKS);
      expect(puts.map((c) => (c[1] as RequestInit).method)).toEqual(Array(TOTAL_CHUNKS).fill("PUT"));
      expect(rangesOf(puts)).toEqual([
        [0, CHUNK - 1],
        [CHUNK, 2 * CHUNK - 1],
        [2 * CHUNK, 3 * CHUNK - 1],
        [3 * CHUNK, 4 * CHUNK - 1],
        [4 * CHUNK, 5 * CHUNK - 1],
        [FINAL_START, TOTAL - 1],
      ]);
      expect(contentRange(puts[5])).toBe(`bytes ${FINAL_START}-${TOTAL - 1}/${TOTAL}`);
      expect(headersOf(puts[0][1])["Content-Type"]).toBe("video/mp4");
      puts.forEach((call, index) => expectBodyFrom(call, index * CHUNK));
      expect(String(puts[0][0])).toBe(URL_1);
    });

    it("holds at most one chunk at a time: no body is above 20 MiB, and the blob is read with a single GET", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      await run(bigCtx(store));

      for (const call of upload.puts()) expect(bodyOf(call).length).toBeLessThan(20 * MIB);
      expect(upload.blobGets()).toHaveLength(1);
      expect(streams.opened).toBe(1);
      expect(streams.cancelled).toBe(1); // closed when the step ended
    });

    it("an upload_url that is not an https URL is TIKTOK_INIT_MISSING_FIELDS: nothing is saved or sent", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubTikTok({
        init: [() => jsonResponse({ data: { publish_id: "p", upload_url: "http://upload.example/x?upload_id=SECRET-9" } })],
      });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("TIKTOK_INIT_MISSING_FIELDS");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(upload.puts()).toHaveLength(0);
      expect(everythingLogged()).not.toContain("SECRET-9");
    });

    it("a video/init rate limit defers before anything is saved (RATE_LIMITED)", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubTikTok({ init: [reply(429)] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(upload.puts()).toHaveLength(0);
    });

    it("a creator_info 429 is RATE_LIMITED, with nothing saved and no init", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubTikTok({ creator: reply(429) });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(upload.inits()).toHaveLength(0);
    });

    it("a 401 from video/init still flags the connection (guarded) and throws the reconnect code", async () => {
      const { store, mocks } = fakeStore();
      stubTikTok({ init: [reply(401, "{}")] });

      const error = await failure(bigCtx(store, { socialConnection: makeConnection({ id: "conn-9" }) }));

      expect(error?.code).toBe(RECONNECT_CODE);
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].where).toEqual({ id: "conn-9" });
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("an image never takes the streamed path: the small path refuses it, before init", async () => {
      const { store, mocks } = fakeStore();
      const upload = stubTikTok();
      const ctx = bigCtx(store);
      ctx.mediaItem = { ...ctx.mediaItem, mimeType: "image/png" } as MediaItem;

      expect((await failure(ctx))?.code).toBe("TIKTOK_MEDIA_NOT_VIDEO");
      expect(upload.inits()).toHaveLength(0);
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });

  describe("across steps", () => {
    it("a 6-chunk file over 2 steps: creator_info and init once in total, contiguous ranges, the last ending at size - 1", async () => {
      const { store, saved } = fakeStore();

      // Step 1: the third chunk is answered with 50 s of the step left: too little for another chunk.
      const first = stubTikTok({ puts: [acceptChunk, acceptChunk, after(STEP - 50_000, acceptChunk)] });
      const step1 = await run(bigCtx(store, { deadline: Date.now() + STEP }));
      expect(step1).toEqual(paused);
      expect((saved()?.data as StateData).nextChunk).toBe(3);
      vi.unstubAllGlobals();

      // The run sleeps, then step 2 starts with a whole budget and no `continuation` hint it relies on.
      vi.setSystemTime(NOW + 10 * 60_000);
      const second = stubTikTok({ puts: accepts(3), init: [] });
      const step2 = await run(bigCtx(store, { deadline: Date.now() + STEP, continuation: 1 }));

      expect(step2).toEqual({ externalPostId: "publish-1" });
      expect(first.creatorInfoCalls().length + second.creatorInfoCalls().length).toBe(1);
      expect(first.inits().length + second.inits().length).toBe(1);
      const puts = [...first.puts(), ...second.puts()];
      const ranges = rangesOf(puts);
      expect(ranges).toHaveLength(TOTAL_CHUNKS);
      expect(ranges[0][0]).toBe(0);
      ranges.forEach(([start], index) => {
        if (index > 0) expect(start).toBe(ranges[index - 1][1] + 1);
      });
      expect(ranges[TOTAL_CHUNKS - 1][1]).toBe(TOTAL - 1);
      for (const call of puts) expect(bodyOf(call).length).toBeLessThan(20 * MIB);
      puts.forEach((call, index) => expectBodyFrom(call, index * CHUNK));
      // One blob GET per step, each from the byte the step starts at.
      expect(headersOf(second.blobGets()[0][1])["Range"]).toBe(`bytes=${3 * CHUNK}-`);
      expect(second.blobGets()).toHaveLength(1);
    });

    it("a step with no time for a chunk saves and continues without touching TikTok or the blob", async () => {
      const { store, saved } = fakeStore(stateAt(2));
      const upload = stubTikTok();

      const result = await run(bigCtx(store, { deadline: Date.now() + LARGE_UPLOAD_CHUNK_WINDOW_MS - 1 }));

      expect(result).toEqual(paused);
      expect(upload.fetchMock).not.toHaveBeenCalled();
      expect((saved()?.data as StateData).nextChunk).toBe(2);
      expect((saved()?.secret as { uploadUrl: string }).uploadUrl).toBe(URL_1);
    });

    it("a chunk starts with exactly 60 s left", async () => {
      const { store } = fakeStore(stateAt(1));
      // The chunk takes 1 ms, which leaves the next one 59.999 s.
      const upload = stubTikTok({ puts: [after(1, acceptChunk)] });

      const result = await run(bigCtx(store, { deadline: Date.now() + LARGE_UPLOAD_CHUNK_WINDOW_MS }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(1);
    });

    it("decides start or resume from the saved state alone: state + continuation 0 resumes, no state + continuation 3 starts", async () => {
      const resumed = fakeStore(stateAt(4));
      const a = stubTikTok({ puts: accepts(2) });
      await run(bigCtx(resumed.store, { continuation: 0 }));
      expect(a.inits()).toHaveLength(0);
      expect(a.creatorInfoCalls()).toHaveLength(0);
      expect(rangesOf(a.puts())[0][0]).toBe(4 * CHUNK);
      vi.unstubAllGlobals();

      const fresh = fakeStore();
      const b = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });
      await run(bigCtx(fresh.store, { continuation: 3 }));
      expect(b.inits()).toHaveLength(1);
      expect(rangesOf(b.puts())[0][0]).toBe(0);
    });

    it("a step that starts from saved state keeps using the saved upload_url and publish id", async () => {
      const { store } = fakeStore(stateAt(4, { publishId: "publish-saved" }, uploadUrlOf(7)));
      const upload = stubTikTok({ puts: accepts(2) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-saved" });
      expect(String(upload.puts()[0][0])).toBe(uploadUrlOf(7));
    });

    it("saves its progress after every accepted chunk, so a later failure resumes from where it stopped", async () => {
      const { store, mocks, saved } = fakeStore();
      stubTikTok({ puts: [acceptChunk, acceptChunk, reply(400, "bad")] });

      expect((await failure(bigCtx(store)))?.code).toBe("TIKTOK_UPLOAD_FAILED");

      expect(mocks.save.mock.calls.map((c) => (c[1].data as StateData).nextChunk)).toEqual([0, 1, 2]);
      expect((saved()?.data as StateData).nextChunk).toBe(2);
    });
  });

  describe.each([
    ["wrong size", () => stateAt(2, { size: TOTAL + 1 })],
    ["a chunk size that is not the plan's", () => stateAt(2, { chunkSize: CHUNK + 1 })],
    ["a chunk count that is not the plan's", () => stateAt(2, { totalChunks: 7 })],
    ["a position past the last chunk", () => stateAt(6)],
    ["a negative position", () => stateAt(-1)],
    ["a fractional position", () => stateAt(1.5)],
    ["no publish id", () => stateAt(2, { publishId: "" })],
    ["no start time", () => stateAt(2, { initAt: Number.NaN })],
    ["an upload_url that is not https", () => stateAt(2, {}, "http://upload.example/x?upload_id=SECRET-3")],
    ["no sealed secret", () => ({ data: stateAt(2).data })],
  ])("saved state that cannot be used (%s)", (_name, make) => {
    it("is treated like no state: a new upload starts from chunk 0 and the unusable URL is never used", async () => {
      const { store } = fakeStore(make());
      const upload = stubTikTok({ puts: accepts(TOTAL_CHUNKS) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(upload.inits()).toHaveLength(1);
      expect(upload.creatorInfoCalls()).toHaveLength(1);
      expect(rangesOf(upload.puts())[0][0]).toBe(0);
      expect(String(upload.puts()[0][0])).toBe(URL_1);
      expect(everythingLogged()).not.toContain("SECRET-3");
    });
  });

  describe("416: TikTok's progress does not match ours", () => {
    it("Content-Range `bytes 0-20971519/<size>` (a last-byte index) resyncs to chunk 2", async () => {
      const { store } = fakeStore(stateAt(1));
      const upload = stubTikTok({ puts: [resyncAt(`bytes 0-${2 * CHUNK - 1}/${TOTAL}`), ...accepts(4)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(rangesOf(upload.puts()).map(([start]) => start)).toEqual([CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK, FINAL_START]);
      expect(upload.blobGets()).toHaveLength(1); // the stream was already at chunk 2
    });

    it("Content-Range `bytes 0-20971520/<size>` (a byte count) resyncs to chunk 2 as well", async () => {
      const { store } = fakeStore(stateAt(1));
      const upload = stubTikTok({ puts: [resyncAt(`bytes 0-${2 * CHUNK}/${TOTAL}`), ...accepts(4)] });

      await run(bigCtx(store));

      expect(rangesOf(upload.puts()).map(([start]) => start)).toEqual([CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK, FINAL_START]);
    });

    it("resyncs backwards when TikTok holds less than we thought, reading the blob again from there", async () => {
      const { store } = fakeStore(stateAt(3));
      const upload = stubTikTok({ puts: [resyncAt(`bytes 0-${CHUNK - 1}/${TOTAL}`), ...accepts(5)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(rangesOf(upload.puts()).map(([start]) => start)).toEqual([
        3 * CHUNK,
        CHUNK,
        2 * CHUNK,
        3 * CHUNK,
        4 * CHUNK,
        FINAL_START,
      ]);
      expect(upload.blobGets().map((c) => headersOf(c[1])["Range"])).toEqual([`bytes=${3 * CHUNK}-`, `bytes=${CHUNK}-`]);
      expectBodyFrom(upload.puts()[1], CHUNK);
      expect(streams.cancelled).toBe(streams.opened);
    });

    it("saves the new position, so the next step starts there", async () => {
      const { store, saved } = fakeStore(stateAt(1));
      stubTikTok({ puts: [resyncAt(`bytes 0-${3 * CHUNK - 1}/${TOTAL}`), after(STEP - 50_000, acceptChunk)] });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(paused);
      expect((saved()?.data as StateData).nextChunk).toBe(4);
    });

    it.each([
      ["not on a chunk boundary", `bytes 0-15000000/${TOTAL}`],
      ["the same position it was sent", `bytes 0-${CHUNK - 1}/${TOTAL}`],
      ["a total that is not this video's", `bytes 0-${2 * CHUNK - 1}/${TOTAL + 1}`],
      ["a range that does not start at 0", `bytes 5-${2 * CHUNK - 1}/${TOTAL}`],
      ["a form that cannot be read", "bytes */*"],
    ])("an answer %s fails TIKTOK_UPLOAD_FAILED before the final chunk, and nothing more is sent", async (_name, answer) => {
      const { store } = fakeStore(stateAt(1));
      const upload = stubTikTok({ puts: [resyncAt(answer)] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 416 });
      expect(upload.puts()).toHaveLength(1);
      expect(upload.polls()).toHaveLength(0);
    });

    it("an answer with no Content-Range fails TIKTOK_UPLOAD_FAILED", async () => {
      const { store } = fakeStore(stateAt(1));
      stubTikTok({ puts: [reply(416)] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 416 });
    });

    it("the final chunk's 416 is unchanged: a rejection (TIKTOK_UPLOAD_FAILED), never resent blindly", async () => {
      const { store } = fakeStore(stateAt(5));
      const upload = stubTikTok({ puts: [resyncAt(`bytes 0-${4 * CHUNK - 1}/${TOTAL}`)] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 416 });
      expect(upload.puts()).toHaveLength(1);
    });
  });

  describe("403: the upload_url expired", () => {
    it("starts a new upload and restarts at chunk 0 on the new URL: a second init, PUTs from `bytes 0-`", async () => {
      const { store } = fakeStore(stateAt(2));
      const upload = stubTikTok({ init: [initOk(2)], puts: [reply(403), ...accepts(TOTAL_CHUNKS)] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-2" });
      expect(upload.inits()).toHaveLength(1);
      expect(upload.creatorInfoCalls()).toHaveLength(0); // a continuation step: creator_info ran in the first one
      expect(upload.putsTo(1)).toHaveLength(1);
      expect(rangesOf(upload.putsTo(2))[0][0]).toBe(0);
      expect(rangesOf(upload.putsTo(2))).toHaveLength(TOTAL_CHUNKS);
      expect(String(upload.puts()[1][0])).toBe(URL_2);
      expect(contentRange(upload.puts()[1])).toBe(`bytes 0-${CHUNK - 1}/${TOTAL}`);
      expectBodyFrom(upload.puts()[1], 0);
    });

    it("saves the new upload (URL sealed, new publish id, position 0) as soon as it exists", async () => {
      const { store, mocks } = fakeStore(stateAt(2));
      stubTikTok({ init: [initOk(2)], puts: [reply(403), after(STEP - 50_000, acceptChunk)] });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(paused);
      const saves = mocks.save.mock.calls.map((c) => c[1] as { data: StateData; secret: { uploadUrl: string } });
      expect(saves[0].secret.uploadUrl).toBe(URL_2);
      expect(saves[0].data).toMatchObject({ publishId: "publish-2", nextChunk: 0, initAt: NOW });
      expect(saves[saves.length - 1].data.nextChunk).toBe(1);
    });

    it("a fresh URL that answers 403 too fails TIKTOK_UPLOAD_FAILED instead of starting uploads forever", async () => {
      const { store } = fakeStore(stateAt(2));
      const upload = stubTikTok({ init: [initOk(2), initOk(3)], puts: [reply(403), reply(403)] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 403 });
      expect(upload.inits()).toHaveLength(1);
    });

    it("the final chunk's 403 is unchanged: TIKTOK_UPLOAD_FAILED, with no new init", async () => {
      const { store } = fakeStore(stateAt(5));
      const upload = stubTikTok({ puts: [reply(403)] });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 403 });
      expect(upload.inits()).toHaveLength(0);
    });

    it("a video/init rate limit while renewing defers (RATE_LIMITED), the saved upload staying as it was", async () => {
      const { store, saved } = fakeStore(stateAt(2));
      stubTikTok({ init: [reply(429)], puts: [reply(403)] });

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
      expect((saved()?.data as StateData).nextChunk).toBe(2);
      expect((saved()?.secret as { uploadUrl: string }).uploadUrl).toBe(URL_1);
    });
  });

  describe("the upload_url is about to expire (1 h, 10 min safety)", () => {
    it("renews it before sending anything when under 10 min of its hour are left, and restarts at chunk 0", async () => {
      const { store } = fakeStore(stateAt(2, { initAt: NOW - (TIKTOK_UPLOAD_URL_TTL_MS - TIKTOK_UPLOAD_URL_SAFETY_MS) - 1 }));
      const upload = stubTikTok({ init: [initOk(2)], puts: accepts(TOTAL_CHUNKS) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-2" });
      expect(upload.inits()).toHaveLength(1);
      expect(upload.putsTo(1)).toHaveLength(0);
      expect(rangesOf(upload.putsTo(2))[0][0]).toBe(0);
    });

    it("keeps it with exactly 10 min left", async () => {
      const { store } = fakeStore(stateAt(2, { initAt: NOW - (TIKTOK_UPLOAD_URL_TTL_MS - TIKTOK_UPLOAD_URL_SAFETY_MS) }));
      const upload = stubTikTok({ puts: accepts(4) });

      await run(bigCtx(store));

      expect(upload.inits()).toHaveLength(0);
      expect(upload.putsTo(1)).toHaveLength(4);
    });

    it("renews it for the final chunk too, as long as the final chunk has not been sent", async () => {
      const { store } = fakeStore(stateAt(5, { initAt: NOW - TIKTOK_UPLOAD_URL_TTL_MS }));
      const upload = stubTikTok({ init: [initOk(2)], puts: accepts(TOTAL_CHUNKS) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-2" });
      expect(upload.putsTo(1)).toHaveLength(0);
      expect(rangesOf(upload.putsTo(2))[0][0]).toBe(0);
    });

    it("does not renew it in a step that has no time to use the new one", async () => {
      const { store } = fakeStore(stateAt(2, { initAt: NOW - TIKTOK_UPLOAD_URL_TTL_MS }));
      const upload = stubTikTok();

      const result = await run(bigCtx(store, { deadline: Date.now() + 30_000 }));

      expect(result).toEqual(paused);
      expect(upload.inits()).toHaveLength(0);
    });
  });

  describe("the final chunk is the commit call", () => {
    it("is sent only with at least 150 s left: with 140 s it saves and continues, with no final PUT", async () => {
      const { store, saved } = fakeStore(stateAt(5));
      const upload = stubTikTok({ puts: accepts(1) });

      const result = await run(bigCtx(store, { deadline: Date.now() + 140_000 }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(0);
      expect(upload.polls()).toHaveLength(0);
      expect((saved()?.data as StateData).nextChunk).toBe(5);
    });

    it("the boundary: 149.999 s pauses, 150 s sends the final chunk and polls in the same step", async () => {
      const a = fakeStore(stateAt(5));
      const short = stubTikTok({ puts: accepts(1) });
      expect(await run(bigCtx(a.store, { deadline: Date.now() + TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS - 1 }))).toEqual(paused);
      expect(short.puts()).toHaveLength(0);
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(5));
      const enough = stubTikTok({ puts: accepts(1) });
      const result = await run(bigCtx(b.store, { deadline: Date.now() + TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS }));
      expect(result).toEqual({ externalPostId: "publish-1" });
      expect(enough.puts()).toHaveLength(1);
      expect(enough.polls()).toHaveLength(1);
    });

    it("re-checks the window after reading the chunk: a slow blob read that eats it pauses, with no PUT", async () => {
      const { store, saved } = fakeStore(stateAt(5));
      // 200 s left at the start; reading the 10 MiB tail takes 100 s, leaving 100 s: under 150.
      const upload = stubTikTok({ blobAdvance: 100_000, puts: accepts(1) });

      const result = await run(bigCtx(store, { deadline: Date.now() + 200_000 }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(0);
      expect((saved()?.data as StateData).nextChunk).toBe(5);
      expect(streams.cancelled).toBe(streams.opened);
    });

    it("a 201 goes on to the status poll inside the same call, then returns the publish id", async () => {
      const { store } = fakeStore(stateAt(5));
      const upload = stubTikTok({ puts: accepts(1) });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "publish-1" });
      const putIndex = upload.fetchMock.mock.calls.indexOf(upload.puts()[0]);
      const pollIndex = upload.fetchMock.mock.calls.indexOf(upload.polls()[0]);
      expect(pollIndex).toBeGreaterThan(putIndex);
      expect(JSON.parse((upload.polls()[0][1] as RequestInit).body as string)).toEqual({ publish_id: "publish-1" });
      expect(contentRange(upload.puts()[0])).toBe(`bytes ${FINAL_START}-${TOTAL - 1}/${TOTAL}`);
    });

    it("the stream is closed before the poll starts", async () => {
      const { store } = fakeStore(stateAt(5));
      const upload = stubTikTok({
        puts: accepts(1),
        status: () => {
          expect(streams.cancelled).toBe(streams.opened);
          return statusComplete({ url: "", init: {} });
        },
      });

      await run(bigCtx(store));

      expect(upload.polls()).toHaveLength(1);
    });

    it("a 503 on the final chunk is PUBLISH_UNCONFIRMED, without polling and without a resend", async () => {
      const { store } = fakeStore(stateAt(5));
      const upload = stubTikTok({ puts: [reply(503, "busy")] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(isTransientPublishError(error)).toBe(false);
      expect(upload.puts()).toHaveLength(1);
      expect(upload.polls()).toHaveLength(0);
    });

    it("the in-step retry never re-runs it: one init, and the final chunk is sent once", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ puts: [...accepts(5), reply(503, "busy")] });

      const error = await caught(withTransientRetries(() => run(bigCtx(store)), { sleep: async () => {} }));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.inits()).toHaveLength(1);
      expect(upload.puts()).toHaveLength(TOTAL_CHUNKS);
    });

    it.each([
      ["a timeout", () => timeout()],
      ["a dropped connection", () => connectionReset()],
    ] as const)("%s on the final chunk is PUBLISH_UNCONFIRMED", async (_name, bad) => {
      const { store } = fakeStore(stateAt(5));
      stubTikTok({ puts: [bad()] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a final chunk that never connected is rethrown unchanged (provably not sent)", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      const { store } = fakeStore(stateAt(5));
      stubTikTok({ puts: [failWith(neverConnected)] });

      expect(await failure(bigCtx(store))).toBe(neverConnected);
    });

    it("a final chunk 429 is RATE_LIMITED with the position saved; a 400 is TIKTOK_UPLOAD_FAILED", async () => {
      const a = fakeStore(stateAt(5));
      stubTikTok({ puts: [reply(429)] });
      expect((await failure(bigCtx(a.store)))?.code).toBe("RATE_LIMITED");
      expect((a.saved()?.data as StateData).nextChunk).toBe(5);
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(5));
      stubTikTok({ puts: [reply(400, "bad")] });
      expect(await failure(bigCtx(b.store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 400 });
    });

    // A 2xx final chunk may have been taken: TikTok could be posting. Only the status poll can
    // say, so a rate-limit code in its body is never read as RATE_LIMITED (a deferral would
    // send the upload again: a second post).
    it("a 2xx final chunk whose body says rate_limit_exceeded goes on to the status poll, never RATE_LIMITED", async () => {
      const a = fakeStore(stateAt(5));
      const done = stubTikTok({
        puts: [() => jsonResponse({ error: { code: "rate_limit_exceeded" } }, 200)],
      });
      expect(await run(bigCtx(a.store))).toEqual({ externalPostId: "publish-1" });
      expect(done.polls()).toHaveLength(1);
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(5));
      const pending = stubTikTok({
        puts: [() => jsonResponse({ error: { code: "rate_limit_exceeded" } }, 201)],
        status: () => jsonResponse({ data: { status: "PROCESSING_UPLOAD" } }),
      });
      expect(await failure(bigCtx(b.store))).toMatchObject({ code: "TIKTOK_PUBLISH_PENDING" });
      expect(pending.polls().length).toBeGreaterThan(0);
    });

    it("a non-final chunk keeps its 2xx handling whatever its body says: a 206 advances, a 201 is PUBLISH_UNCONFIRMED", async () => {
      const limitedBody = (status: number): Reply => () => jsonResponse({ error: { code: "rate_limit_exceeded" } }, status);

      const a = fakeStore(stateAt(4));
      const advanced = stubTikTok({ puts: [limitedBody(206), acceptChunk] });
      expect(await run(bigCtx(a.store))).toEqual({ externalPostId: "publish-1" });
      expect(rangesOf(advanced.puts())).toEqual([
        [4 * CHUNK, 5 * CHUNK - 1],
        [FINAL_START, TOTAL - 1],
      ]);
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(4));
      const early = stubTikTok({ puts: [limitedBody(201), acceptChunk] });
      expect((await failure(bigCtx(b.store)))?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(early.puts()).toHaveLength(1);
    });

    it("a status poll that answers 401 stays PUBLISH_UNCONFIRMED (the connection is flagged, no reconnect-and-retry)", async () => {
      const { store } = fakeStore(stateAt(5));
      stubTikTok({ puts: accepts(1), status: reply(401, "{}") });

      const error = await failure(bigCtx(store, { socialConnection: makeConnection({ id: "conn-4" }) }));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].where).toEqual({ id: "conn-4" });
    });

    it("a poll that reports FAILED is TIKTOK_PUBLISH_FAILED, and one that never finishes is TIKTOK_PUBLISH_PENDING", async () => {
      const a = fakeStore(stateAt(5));
      stubTikTok({ puts: accepts(1), status: () => jsonResponse({ data: { status: "FAILED", fail_reason: "file_format_check_failed" } }) });
      expect(await failure(bigCtx(a.store))).toMatchObject({ code: "TIKTOK_PUBLISH_FAILED" });
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(5));
      stubTikTok({ puts: accepts(1), status: () => jsonResponse({ data: { status: "PROCESSING_UPLOAD" } }) });
      expect(await failure(bigCtx(b.store))).toMatchObject({ code: "TIKTOK_PUBLISH_PENDING" });
    });
  });

  describe("a chunk that is not the last fails, or runs into the step deadline", () => {
    it.each([
      ["a 503", () => reply(503, "busy")],
      ["a 502", () => reply(502, "bad gateway")],
      ["a timeout", () => timeout()],
      ["a dropped connection", () => connectionReset()],
      ["a body cut off by undici", () => failWith(new TypeError("terminated"))],
      ["a connection that never reached TikTok", () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))],
    ] as const)("%s saves and continues 30 s later; the same chunk is retried in the next step", async (_name, bad) => {
      const { store, saved } = fakeStore();
      const upload = stubTikTok({ puts: [acceptChunk, acceptChunk, bad()] });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(3); // no second try in this step
      expect((saved()?.data as StateData).nextChunk).toBe(2);
      expect((saved()?.secret as { uploadUrl: string }).uploadUrl).toBe(URL_1);
      expect(streams.cancelled).toBe(streams.opened);
      vi.unstubAllGlobals();

      // The next step PUTs the same chunk again.
      const next = stubTikTok({ puts: accepts(4) });
      const resumed = await run(bigCtx(store, { deadline: Date.now() + STEP, continuation: 1 }));
      expect(resumed).toEqual({ externalPostId: "publish-1" });
      expect(rangesOf(next.puts())[0]).toEqual([2 * CHUNK, 3 * CHUNK - 1]);
      expect(next.inits()).toHaveLength(0);
    });

    it.each([
      ["times out when the budget ends", () => timeout()],
      ["gets a 503 as the budget ends", () => reply(503, "unavailable")],
      ["loses its connection as the budget ends", () => connectionReset()],
    ] as const)("a chunk that %s pauses - it is not a failure of the upload", async (_name, bad) => {
      const { store, saved } = fakeStore();
      const upload = stubTikTok({ puts: [after(STEP - 2_000, bad())] });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(1);
      expect((saved()?.data as StateData).nextChunk).toBe(0);
    });

    it("a chunk that is never sent because the budget ran out while the blob was read pauses too (no PUT, nothing lost)", async () => {
      const { store, saved } = fakeStore();
      // The window check passes (225 s left); reading the chunk then takes all but 3 s.
      const upload = stubTikTok({ blobAdvance: STEP - 3_000 });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(0);
      expect((saved()?.data as StateData).nextChunk).toBe(0);
    });

    it("a blob read that is aborted by the step deadline pauses instead of failing the upload", async () => {
      const { store, saved } = fakeStore(stateAt(1));
      const upload = stubTikTok();
      const real = upload.fetchMock.getMockImplementation()!;
      upload.fetchMock.mockImplementation(async (input, init) => {
        const response = await real(input, init);
        if (!String(input).includes("blob.example.com")) return response;
        // The body fails as the deadline hits: the step's time is gone when the read errors.
        advance(STEP - 1_000);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
            },
          }),
          { status: 206, headers: { "Content-Range": `bytes ${CHUNK}-${TOTAL - 1}/${TOTAL}` } },
        );
      });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(paused);
      expect(upload.puts()).toHaveLength(0);
      expect((saved()?.data as StateData).nextChunk).toBe(1);
    });

    it("a blob body that drops part-way through with plenty of time left pauses 30 s with the saved place intact (nothing was sent)", async () => {
      const { store, saved } = fakeStore(stateAt(1));
      const upload = stubTikTok();
      upload.fetchMock.mockImplementation(async () => {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (sent) return controller.error(new TypeError("terminated"));
                sent = true;
                controller.enqueue(new Uint8Array(1_000));
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 206, headers: { "Content-Range": `bytes ${CHUNK}-${TOTAL - 1}/${TOTAL}` } },
        );
      });

      const result = await run(bigCtx(store, { deadline: Date.now() + STEP }));

      expect(result).toEqual(pausedFor(TRANSIENT_RESUME_DELAY));
      expect(upload.puts()).toHaveLength(0);
      expect(saved()).toEqual({ kind: TIKTOK_UPLOAD_STATE_KIND, ...stateAt(1) });
    });

    it("a 429 saves the position and throws RATE_LIMITED; the deferral resumes from there", async () => {
      const { store, saved } = fakeStore();
      stubTikTok({ puts: [acceptChunk, acceptChunk, reply(429, null, { "Retry-After": "60" })] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("RATE_LIMITED");
      expect((saved()?.data as StateData).nextChunk).toBe(2);
      expect((saved()?.secret as { uploadUrl: string }).uploadUrl).toBe(URL_1);
      vi.unstubAllGlobals();

      const next = stubTikTok({ puts: accepts(4) });
      await run(bigCtx(store));
      expect(next.inits()).toHaveLength(0);
      expect(rangesOf(next.puts())[0][0]).toBe(2 * CHUNK);
    });

    it("a rate limit whose save fails still surfaces as the rate limit", async () => {
      const { store, mocks } = fakeStore(stateAt(2));
      stubTikTok({ puts: [reply(429)] });
      mocks.save.mockRejectedValue(Object.assign(new Error("gone"), { code: "RESULT_CLAIM_LOST" }));

      expect((await failure(bigCtx(store)))?.code).toBe("RATE_LIMITED");
    });

    it("a 400 or a 404 is a rejection: TIKTOK_UPLOAD_FAILED with its status, no pause", async () => {
      const a = fakeStore(stateAt(2));
      stubTikTok({ puts: [reply(400, "bad")] });
      expect(await failure(bigCtx(a.store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 400 });
      vi.unstubAllGlobals();

      const b = fakeStore(stateAt(2));
      stubTikTok({ puts: [reply(404, "no task")] });
      expect(await failure(bigCtx(b.store))).toMatchObject({ code: "TIKTOK_UPLOAD_FAILED", status: 404 });
    });

    it("a 2xx other than 206 before the last chunk means TikTok thinks the upload is complete: PUBLISH_UNCONFIRMED, nothing more is sent", async () => {
      const { store } = fakeStore(stateAt(1));
      const upload = stubTikTok({ puts: [reply(201), acceptChunk] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(upload.puts()).toHaveLength(1);
    });

    it("an error that is not a chunk failure (a bug, say) is not swallowed as a pause", async () => {
      const { store } = fakeStore(stateAt(1));
      stubTikTok({ puts: [failWith(new RangeError("boom"))] });

      expect(await failure(bigCtx(store))).toBeInstanceOf(RangeError);
    });

    it("a TypeError that is not undici's network failure is a bug: it surfaces instead of pausing", async () => {
      const { store, mocks } = fakeStore(stateAt(1));
      const bug = new TypeError("x is not a function");
      stubTikTok({ puts: [failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });

  describe("the blob", () => {
    it("a blob that cannot be read fails BLOB_READ_FAILED before any chunk is sent", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ blobStatus: 404 });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "BLOB_READ_FAILED", status: 404 });
      expect(upload.puts()).toHaveLength(0);
    });

    it("a blob that refuses the Range read of a resumed upload (a 4xx) still fails, it does not pause", async () => {
      const { store } = fakeStore(stateAt(2));
      const upload = stubTikTok({ blobStatus: 403 });

      expect(await failure(bigCtx(store))).toMatchObject({ code: "BLOB_READ_FAILED", status: 403 });
      expect(upload.puts()).toHaveLength(0);
    });

    it("an in-step retry after a blob failure resumes from the saved upload: one creator_info, one init, six chunks", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ blobFailures: 1, puts: accepts(TOTAL_CHUNKS) });

      const result = await caught(
        withTransientRetries(() => run(bigCtx(store)), { sleep: async () => {} }),
      );

      expect(result).toBeNull();
      expect(upload.creatorInfoCalls()).toHaveLength(1);
      expect(upload.inits()).toHaveLength(1);
      expect(upload.puts()).toHaveLength(TOTAL_CHUNKS);
      expect(upload.blobGets()).toHaveLength(2);
    });

    it("a blob whose size is not the recorded size fails MEDIA_SIZE_MISMATCH before any chunk is sent", async () => {
      const { store } = fakeStore();
      const upload = stubTikTok({ blobClaimsTotal: TOTAL + 10 });

      expect((await failure(bigCtx(store)))?.code).toBe("MEDIA_SIZE_MISMATCH");
      expect(upload.puts()).toHaveLength(0);
    });
  });

  describe("no capability URL leaks", () => {
    const SECRETS = ["SECRET-1", "TOKEN-1", "SECRET-2", "TOKEN-2", "open-upload.tiktokapis.example"];

    function expectNoUrl(...texts: string[]) {
      for (const text of texts) {
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(text).not.toContain("upload_id");
      }
    }

    it("a whole upload over two steps: the upload_url is only in the sealed `secret` - never in `data`, a log, or a returned value", async () => {
      const { store, mocks } = fakeStore();
      stubTikTok({ puts: [acceptChunk, acceptChunk, after(STEP - 50_000, acceptChunk)] });
      const step1 = await run(bigCtx(store, { deadline: Date.now() + STEP }));
      vi.unstubAllGlobals();
      vi.setSystemTime(NOW + 600_000);
      stubTikTok({ puts: accepts(3), init: [] });
      const step2 = await run(bigCtx(store, { deadline: Date.now() + STEP, continuation: 1 }));

      expect(mocks.save).toHaveBeenCalled();
      for (const [, snapshot] of mocks.save.mock.calls as Array<[string, { data: unknown; secret?: { uploadUrl: string } }]>) {
        expectNoUrl(JSON.stringify(snapshot.data));
        expect(JSON.stringify(snapshot.data)).not.toContain("://");
        expect(snapshot.secret).toEqual({ uploadUrl: URL_1 });
      }
      expectNoUrl(JSON.stringify(step1), JSON.stringify(step2), everythingLogged());
    });

    it("a re-init saves the new URL only sealed, and logs nothing of either URL", async () => {
      const { store, mocks } = fakeStore(stateAt(2));
      stubTikTok({ init: [initOk(2)], puts: [reply(403), ...accepts(TOTAL_CHUNKS)] });

      const result = await run(bigCtx(store));

      for (const [, snapshot] of mocks.save.mock.calls as Array<[string, { data: unknown }]>) {
        expectNoUrl(JSON.stringify(snapshot.data));
      }
      expectNoUrl(JSON.stringify(result), everythingLogged());
    });

    it.each([
      ["a 400 on a chunk", 2, () => [reply(400, "bad")]],
      ["a 404 on a chunk", 2, () => [reply(404, "no task")]],
      ["a 403 on the renewed URL", 2, () => [reply(403), reply(403)]],
      ["a 429 on a chunk", 2, () => [reply(429)]],
      ["a 503 on the final chunk", 5, () => [reply(503)]],
      ["a timeout on the final chunk", 5, () => [timeout()]],
      ["a bad Content-Range on a 416", 2, () => [resyncAt(`bytes 0-15000000/${TOTAL}`)]],
    ] as const)("%s: the error and the logs carry no URL", async (_name, at, puts) => {
      const { store } = fakeStore(stateAt(at));
      stubTikTok({ init: [initOk(2), initOk(3)], puts: [...puts()] });

      const error = await failure(bigCtx(store));

      expect(error).not.toBeNull();
      expectNoUrl(describeError(error), everythingLogged());
    });

    it("a video/init payload that has an upload_url but no publish id is logged without the URL", async () => {
      const { store } = fakeStore();
      stubTikTok({ init: [() => jsonResponse({ data: { upload_url: URL_1 }, error: { code: "ok" } })] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("TIKTOK_INIT_MISSING_FIELDS");
      expectNoUrl(describeError(error), everythingLogged());
    });
  });
});
