import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { truncateGraphemes } from "@/lib/truncate";

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
  TIKTOK_MAX_CHUNK_SIZE,
  TIKTOK_MAX_FINAL_CHUNK_SIZE,
  TIKTOK_POLL_INTERVAL_MS,
  TIKTOK_POLL_MAX_ATTEMPTS,
  tiktokClient,
} from "./tiktokClient";

// markConnectionNeedsReconnect and the token-refresh persist both resolve
// prisma via `await import("@/lib/db")` at call time, so they receive this
// mock. No real database is touched, and no real TikTok endpoint is called:
// every network call below goes through a stubbed global `fetch`.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
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
  it("falls back to the default title when caption is empty", () => {
    expect(computeTikTokCaption("")).toBe("Video posted via Vibe Socials");
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
      connectionId: "conn-1",
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
      pollTikTokPublishStatus({ accessToken: "a", publishId: "p", connectionId: "c", deadline }),
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

  it("maps a 401 from the status endpoint to TIKTOK_RECONNECT_REQUIRED and flags the connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "access_token_invalid", message: "bad token" } }, 401),
      ),
    );

    const error = await caught(poll({ connectionId: "conn-42" }));

    expect(error?.code).toBe(RECONNECT_CODE);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].where).toEqual({ id: "conn-42" });
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
    expect(updateCalls()[0].data.lastRefreshErrorCode).toBe(RECONNECT_CODE);
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

      const error = await caught(refreshTikTokToken(makeConnection({ refreshToken: null })));

      expect(error?.code).toBe(RECONNECT_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateCalls()).toHaveLength(1);
      expect(updateCalls()[0].data.needsReconnect).toBe(true);
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
      mediaItem,
      caption: "hello",
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

  it("maps a 401 from the status poll to TIKTOK_RECONNECT_REQUIRED mid-publish", async () => {
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
    expect(error?.code).toBe(RECONNECT_CODE);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].data.needsReconnect).toBe(true);
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
