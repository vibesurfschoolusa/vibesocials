import { NonRetriableError } from "inngest";
import { Prisma, type Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCaptionWithFooter } from "@/lib/captionFooter";
import { logger } from "@/lib/logger";
import { nextPacificMidnight, rateLimitedError } from "@/server/platforms/rateLimited";
import { instagramClient } from "@/server/platforms/instagramClient";
import { youtubeClient } from "@/server/platforms/youtubeClient";
import { PUBLISH_STEP_BUDGET_MS } from "@/server/platforms/publishBudget";
import type { PublishContext } from "@/server/platforms/types";

// Handler-level tests for the publish pipeline's Inngest functions. vitest
// hoists vi.mock above the imports: every module inngest-functions.ts pulls in
// that touches `@/lib/db` receives this mock, and no platform API is called —
// getPlatformClient returns a stub client whose publishVideo records its ctx.
const db = vi.hoisted(() => ({
  postJobFindUnique: vi.fn(),
  postJobUpdate: vi.fn(),
  postJobUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  mediaItemFindUnique: vi.fn(),
  connectionFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  resultFindMany: vi.fn(),
  resultFindUnique: vi.fn(),
  resultUpdate: vi.fn(),
  resultUpdateMany: vi.fn(),
  /** The `SELECT ... FOR UPDATE` row lock of the finalize recompute. */
  executeRaw: vi.fn(),
}));
const {
  getPlatformClientMock,
  failPendingMock,
  recomputeSpy,
  releaseSpy,
  releaseContinuationSpy,
  uploadStateMocks,
  consumeSlotMock,
  exhaustBudgetMock,
  deliverNotificationMock,
  healResultWorkspaceIdsMock,
  checkXLimitMock,
  checkYoutubeLimitMock,
} = vi.hoisted(() => ({
  getPlatformClientMock: vi.fn(),
  failPendingMock: vi.fn(),
  recomputeSpy: vi.fn(),
  /** Wraps the real releaseClaimForDeferral so its calls can be asserted. */
  releaseSpy: vi.fn(),
  /** Wraps the real releaseClaimForContinuation the same way. */
  releaseContinuationSpy: vi.fn(),
  /** Wraps the real createUploadStateStore; `real` is filled in by the module mock. */
  uploadStateMocks: { createStore: vi.fn(), real: undefined as unknown },
  consumeSlotMock: vi.fn(),
  exhaustBudgetMock: vi.fn(),
  deliverNotificationMock: vi.fn(),
  healResultWorkspaceIdsMock: vi.fn(),
  checkXLimitMock: vi.fn(),
  checkYoutubeLimitMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: {
      findUnique: db.postJobFindUnique,
      update: db.postJobUpdate,
      updateMany: db.postJobUpdateMany,
    },
    user: { findUnique: db.userFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    mediaItem: { findUnique: db.mediaItemFindUnique },
    socialConnection: { findMany: db.connectionFindMany, findUnique: db.connectionFindUnique },
    postJobResult: {
      findMany: db.resultFindMany,
      findUnique: db.resultFindUnique,
      update: db.resultUpdate,
      updateMany: db.resultUpdateMany,
    },
    // The finalize steps recompute the job's status in a row-locked transaction
    // (failPendingResults.ts); its client reads and writes through the same mocks.
    $transaction: (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: db.executeRaw,
        postJobResult: { findMany: db.resultFindMany },
        postJob: { update: db.postJobUpdate },
      }),
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: getPlatformClientMock }));
// Usage limits (2026-11-10): the counts and the owners' email have their own
// suite (workspaceUsage.test.ts); here only where the platform step checks.
vi.mock("@/server/usage/workspaceUsage", () => ({
  checkXMonthlyLimit: checkXLimitMock,
  checkYoutubeDailyLimit: checkYoutubeLimitMock,
}));
// The YouTube upload budget is a database counter (its own suite covers it).
vi.mock("@/server/platforms/youtubeQuota", () => ({
  consumeYouTubeUploadSlot: consumeSlotMock,
  exhaustYouTubeUploadBudget: exhaustBudgetMock,
}));
// The claim helpers stay REAL (against the mocked prisma); only the releases are
// wrapped in spies so the deferral / continuation they record can be asserted.
vi.mock("@/server/jobs/resultClaim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jobs/resultClaim")>();
  releaseSpy.mockImplementation(actual.releaseClaimForDeferral);
  releaseContinuationSpy.mockImplementation(actual.releaseClaimForContinuation);
  return {
    ...actual,
    releaseClaimForDeferral: releaseSpy,
    releaseClaimForContinuation: releaseContinuationSpy,
  };
});
// The upload-state store stays REAL (against the mocked prisma, its own suite
// covers it); the factory is wrapped so a test can see which store each step
// built, or swap in an in-memory one.
vi.mock("@/server/jobs/uploadState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jobs/uploadState")>();
  uploadStateMocks.real = actual.createUploadStateStore;
  uploadStateMocks.createStore.mockImplementation(actual.createUploadStateStore);
  return { ...actual, createUploadStateStore: uploadStateMocks.createStore };
});
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
// The hourly workspace heal has its own suite (resultWorkspaceHeal.test.ts); the
// sweep tests only need to see when it runs and how its failure is handled.
vi.mock("@/server/jobs/resultWorkspaceHeal", () => ({
  RESULT_WORKSPACE_HEAL_BATCH: 1000,
  healResultWorkspaceIds: healResultWorkspaceIdsMock,
}));
// The email builder / Resend transport have their own suites; sendNotification's
// job is the Inngest options and the step boundary.
vi.mock("@/server/notifications/postOutcomeEmail", () => ({
  deliverPostOutcomeNotification: deliverNotificationMock,
}));
// failPendingPostJobResults is stubbed (its own suite covers it); the locked
// recompute stays REAL but is wrapped in a spy, so the finalize steps' calls to
// it can be asserted while their DB reads and writes still run against the mocks.
vi.mock("@/server/jobs/failPendingResults", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/jobs/failPendingResults")>();
  recomputeSpy.mockImplementation(actual.recomputeAndStorePostJobStatus);
  return {
    ...actual,
    failPendingPostJobResults: failPendingMock,
    recomputeAndStorePostJobStatus: recomputeSpy,
  };
});

import { EmailRetryableError } from "@/server/notifications/email";
import { CONNECTION_GONE_FAILURE } from "./failPendingResults";
import {
  failInterruptedPublishRun,
  failInterruptedRetryRun,
  publishToAllPlatforms,
  retryPlatforms,
  sendNotification,
  stalePostJobSweep,
} from "./inngest-functions";
import { PUBLISH_PRIORITY, publishConcurrency } from "./publishFlowControl";
import { STALE_AFTER_MS } from "./stalePostJobs";

const WORKSPACE = { id: "ws-1", companyWebsite: null, defaultHashtags: "#brand" };

type HandlerArgs = {
  event: { name: string; data: Record<string, unknown> };
  step: FakeStep;
  /** The Inngest run id (the identity a platform step claims its result under). */
  runId?: string;
};
type FakeStep = ReturnType<typeof fakeStep>;

/**
 * Minimal stand-in for Inngest's `step`: runs each step inline and
 * JSON-round-trips its output the way Inngest's memoization does (Dates come
 * back as strings), so a step that leaks a non-serializable value shows up here.
 */
function fakeStep() {
  /** `run:<id>` / `sleepUntil:<id>` / `sendEvent:<id>` in call order. */
  const order: string[] = [];
  /** Each `step.run` output by step id (what Inngest memoizes). */
  const outputs: Record<string, unknown> = {};
  return {
    order,
    outputs,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      order.push(`run:${id}`);
      const out = await cb();
      const stored = out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      outputs[id] = stored;
      return stored;
    }),
    // Durable sleeps return at once: nothing here waits on a clock.
    sleepUntil: vi.fn(async (id: string) => {
      order.push(`sleepUntil:${id}`);
    }),
    sendEvent: vi.fn(async (id: string) => {
      order.push(`sendEvent:${id}`);
      return { ids: [] as string[] };
    }),
  };
}

/**
 * The function's handler. `fn` is private in Inngest's types but plain at
 * runtime. Runs as `run-1` unless a test passes its own `runId`.
 */
function handlerOf(fn: unknown): (args: HandlerArgs) => Promise<unknown> {
  const handler = (fn as { fn: (args: HandlerArgs) => Promise<unknown> }).fn;
  return (args) => handler({ runId: "run-1", ...args });
}

function connectionRow(platform: Platform) {
  return {
    id: `conn-${platform}`,
    platform,
    userId: "user-1",
    workspaceId: WORKSPACE.id,
    accessToken: "token",
    refreshToken: null,
    expiresAt: null,
    needsReconnect: false,
    metadata: null,
  };
}

let publishCtxs: PublishContext[];

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  getPlatformClientMock.mockReset();
  failPendingMock.mockReset();
  recomputeSpy.mockClear();
  releaseSpy.mockClear();
  releaseContinuationSpy.mockClear();
  uploadStateMocks.createStore.mockReset();
  uploadStateMocks.createStore.mockImplementation(
    uploadStateMocks.real as (...args: unknown[]) => unknown,
  );
  consumeSlotMock.mockReset();
  exhaustBudgetMock.mockReset();
  // The YouTube upload budget is open unless a test closes it.
  consumeSlotMock.mockResolvedValue({ allowed: true });
  exhaustBudgetMock.mockResolvedValue(undefined);
  // The workspace's own limits are open unless a test reaches them.
  checkXLimitMock.mockReset();
  checkYoutubeLimitMock.mockReset();
  checkXLimitMock.mockResolvedValue(null);
  checkYoutubeLimitMock.mockResolvedValue(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  publishCtxs = [];
  getPlatformClientMock.mockImplementation(() => ({
    publishVideo: vi.fn(async (ctx: PublishContext) => {
      publishCtxs.push(ctx);
      return { externalPostId: `ext-${ctx.socialConnection.platform}` };
    }),
  }));

  db.userFindUnique.mockResolvedValue({ id: "user-1" });
  db.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  db.connectionFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(connectionRow(where.id.replace("conn-", "") as Platform)),
  );
  db.resultUpdate.mockResolvedValue({});
  // Every platform step first claims its result with one conditional
  // updateMany (resultClaim.ts); by default the claim is won. (A repoint write
  // also goes through updateMany and ignores the count.)
  db.resultUpdateMany.mockResolvedValue({ count: 1 });
  // Read back only when a claim is lost (claimResult) and, on a retry, for the
  // result's current connection; by default an unclaimed `pending` row.
  db.resultFindUnique.mockResolvedValue({ status: "pending", claimRunId: null });
  db.postJobUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Result rows: `select: { id, platform, ... }` lookups get ids (each pointing at
 * its platform's current connection); status lookups get statuses.
 */
function stubResults(platforms: Platform[], status: "success" | "failed" = "success") {
  db.resultFindMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Promise.resolve(
      select.platform
        ? platforms.map((p) => ({ id: `result-${p}`, platform: p, socialConnectionId: `conn-${p}` }))
        : platforms.map(() => ({ status })),
    ),
  );
}

function ctxFor(platform: Platform): PublishContext {
  const ctx = publishCtxs.find((c) => c.socialConnection.platform === platform);
  if (!ctx) throw new Error(`no publish for ${platform}`);
  return ctx;
}

describe("retryPlatforms — caption source (Task 4 item 1)", () => {
  const media = {
    id: "media-1",
    baseCaption: "Caption from the original upload",
    perPlatformOverrides: { x: "media-level X override" },
    deletedAt: null,
    mimeType: "video/mp4",
  };

  function retry(platforms: Platform[]) {
    return handlerOf(retryPlatforms)({
      event: {
        name: "post/retry.requested",
        data: { postJobId: "job-1", userId: "user-1", platforms },
      },
      step: fakeStep(),
    });
  }

  beforeEach(() => {
    db.mediaItemFindUnique.mockResolvedValue(media);
    db.connectionFindMany.mockResolvedValue([
      { id: "conn-x", platform: "x" },
      { id: "conn-youtube", platform: "youtube" },
    ]);
    stubResults(["x", "youtube"]);
  });

  it("re-publishes the JOB's own caption and overrides, not the shared media item's", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: WORKSPACE.id,
      mediaItemId: "media-1",
      baseCaption: "Typed for this post",
      perPlatformOverrides: { x: "job-level X override" },
      publishMetadata: null,
    });

    await retry(["x", "youtube"]);

    expect(ctxFor("x").caption).toBe(buildCaptionWithFooter("job-level X override", WORKSPACE));
    expect(ctxFor("youtube").caption).toBe(buildCaptionWithFooter("Typed for this post", WORKSPACE));
    // YouTube's title source (no footer) is the job's caption too.
    expect(ctxFor("youtube").baseCaption).toBe("Typed for this post");
  });

  it("falls back to the media item for a legacy job with no snapshot", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: WORKSPACE.id,
      mediaItemId: "media-1",
      baseCaption: null,
      perPlatformOverrides: null,
      publishMetadata: null,
    });

    await retry(["x", "youtube"]);

    expect(ctxFor("x").caption).toBe(buildCaptionWithFooter("media-level X override", WORKSPACE));
    expect(ctxFor("youtube").baseCaption).toBe("Caption from the original upload");
  });

  // Fix round 1 (review IMPORTANT #1): the job's snapshot is a unit — its
  // caption with null overrides means "no overrides", never the media item's.
  it("does not re-publish the media item's overrides for a job whose snapshot has none", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: WORKSPACE.id,
      mediaItemId: "media-1",
      baseCaption: "Typed for this post",
      perPlatformOverrides: null,
      publishMetadata: null,
    });

    await retry(["x"]);

    expect(ctxFor("x").caption).toBe(buildCaptionWithFooter("Typed for this post", WORKSPACE));
  });
});

describe("publishToAllPlatforms — YouTube title source (Task 4 item 1)", () => {
  it("hands the post's base caption (from the event) to the client for the title", async () => {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({
      id: "media-1",
      baseCaption: "Caption from the original upload",
      deletedAt: null,
    });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-youtube", platform: "youtube" }]);
    stubResults(["youtube"]);

    await handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: {
          postJobId: "job-1",
          userId: "user-1",
          mediaItemId: "media-1",
          baseCaption: "Typed for this post",
          perPlatformOverrides: null,
        },
      },
      step: fakeStep(),
    });

    expect(ctxFor("youtube").baseCaption).toBe("Typed for this post");
    expect(ctxFor("youtube").caption).toBe(buildCaptionWithFooter("Typed for this post", WORKSPACE));
  });
});

// Task 4 items 7 + 10: each platform step gets ONE deadline, stamped before
// its first attempt, which every in-step retry shares.
describe("publishToPlatform — per-step deadline (Task 4 items 7 + 10)", () => {
  it("stamps a deadline PUBLISH_STEP_BUDGET_MS after the step starts and hands it to the client", async () => {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-x", platform: "x" }]);
    stubResults(["x"]);

    const before = Date.now();
    await handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
      },
      step: fakeStep(),
    });
    const after = Date.now();

    const { deadline } = ctxFor("x");
    expect(deadline).toBeGreaterThanOrEqual(before + PUBLISH_STEP_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(after + PUBLISH_STEP_BUDGET_MS);
  });

  it("every in-step retry of the same step shares that one deadline", async () => {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-x", platform: "x" }]);
    stubResults(["x"]);
    const deadlines: Array<number | undefined> = [];
    getPlatformClientMock.mockImplementation(() => ({
      publishVideo: vi.fn(async (ctx: PublishContext) => {
        deadlines.push(ctx.deadline);
        if (deadlines.length === 1) throw Object.assign(new Error("busy"), { status: 503 });
        return { externalPostId: "ext-x" };
      }),
    }));
    vi.useFakeTimers();

    const run = handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
      },
      step: fakeStep(),
    });
    await vi.advanceTimersByTimeAsync(2_000); // the 2s in-step backoff
    await run;
    vi.useRealTimers();

    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]).toEqual(expect.any(Number));
    expect(deadlines[1]).toBe(deadlines[0]);
  });
});

/** What claiming a result writes: the claim itself, and the end of any deferral. */
const CLAIM_DATA = (runId: string) => ({
  claimRunId: runId,
  claimedAt: expect.any(Date),
  deferredUntil: null,
  errorCode: null,
  errorMessage: null,
});

/** Every `postJobResult.update` data payload, in call order. */
function resultWrites(): Array<Record<string, unknown>> {
  return db.resultUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
}

const HEARTBEAT = { postJob: { update: { updatedAt: expect.any(Date) } } };
/** A finalized result drops its saved upload state (uploadState.ts), whichever way it ended. */
const CLEARS_STATE = { uploadState: Prisma.DbNull };

// Task 4 item 6: the stale sweep (6h) and the stuck-in_progress reconciler
// (2h) judge progress by PostJob.updatedAt, but platform steps only wrote
// PostJobResult — so a slow-but-alive run never touched its job row. Every
// finalized result now bumps the job's updatedAt in the same nested write.
describe("publish heartbeat — finalizing a result bumps PostJob.updatedAt (Task 4 item 6)", () => {
  function publish(platforms: Platform[]) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(
      platforms.map((p) => ({ id: `conn-${p}`, platform: p })),
    );
    stubResults(platforms);
    return handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
      },
      step: fakeStep(),
    });
  }

  it("on success", async () => {
    await publish(["x"]);
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "success", externalPostId: "ext-x", ...HEARTBEAT }),
    ]);
  });

  it("on a platform failure", async () => {
    getPlatformClientMock.mockImplementation(() => ({
      publishVideo: vi.fn(async () => {
        throw Object.assign(new Error("nope"), { code: "X_TWEET_FAILED", status: 403 });
      }),
    }));
    await publish(["x"]);
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "X_TWEET_FAILED", ...HEARTBEAT }),
    ]);
  });

  it("when no client exists, the connection is gone, or it needs a reconnect", async () => {
    getPlatformClientMock.mockImplementation((platform: Platform) =>
      platform === "x" ? null : { publishVideo: vi.fn() },
    );
    db.connectionFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === "conn-youtube" ? null : { ...connectionRow("linkedin"), needsReconnect: true },
      ),
    );

    await publish(["x", "youtube", "linkedin"]);

    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "CLIENT_NOT_FOUND", ...HEARTBEAT }),
      expect.objectContaining({ status: "failed", errorCode: "CONNECTION_GONE", ...HEARTBEAT }),
      expect.objectContaining({ status: "failed", errorCode: "RECONNECT_REQUIRED", ...HEARTBEAT }),
    ]);
  });

  it("when a retried platform has lost its connection", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", perPlatformOverrides: null, deletedAt: null });
    db.connectionFindMany.mockResolvedValue([]);
    stubResults(["x"]);

    await handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms: ["x"] } },
      step: fakeStep(),
    });

    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "RECONNECT_REQUIRED", ...HEARTBEAT }),
    ]);
  });
});

// Task 4 items 7 + 9: both publish functions are `retries: 0`. When a run dies
// (a step killed at Vercel's 300s cap, a thrown step), the platforms not yet
// attempted stayed `pending` and the job looked "publishing" for ~2h. An
// Inngest onFailure handler now fails them via the shared
// failPendingPostJobResults helper (which also recomputes the job status).
describe("onFailure — interrupted publish runs (Task 4 items 7 + 9)", () => {
  it.each([
    ["publishToAllPlatforms", publishToAllPlatforms, "publish-to-all-platforms", failInterruptedPublishRun],
    // Fix round 1 (ruling R8b): the retry run has its OWN, platform-scoped handler.
    ["retryPlatforms", retryPlatforms, "retry-platforms", failInterruptedRetryRun],
  ] as const)("%s registers a failure handler for its own function id", (_name, fn, id, handler) => {
    // getConfig is what Inngest's serve() registers; private in the SDK's
    // types, public at runtime.
    const { getConfig } = fn as unknown as {
      getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
    };
    const config = getConfig.call(fn, {
      baseUrl: new URL("https://app.example/api/inngest"),
      appPrefix: "vibe-socials",
    });
    const failure = config.find((c) => c.id === `vibe-socials-${id}-failure`);
    expect(failure?.triggers).toEqual([
      { event: "inngest/function.failed", expression: `event.data.function_id == 'vibe-socials-${id}'` },
    ]);
    // ...and it is THIS module's handler.
    expect((fn as unknown as { onFailureFn?: unknown }).onFailureFn).toBe(handler);
  });

  function failureEvent(data: Record<string, unknown>) {
    return {
      name: "inngest/function.failed",
      data: {
        function_id: "vibe-socials-publish-to-all-platforms",
        run_id: "run-1",
        error: { name: "Error", message: "step timed out" },
        event: { name: "post/publish.requested", data },
      },
    };
  }

  it("fails the job's still-pending results with PUBLISH_INTERRUPTED via the shared helper", async () => {
    failPendingMock.mockResolvedValue({ failedCount: 2, status: "completed" });

    await failInterruptedPublishRun({
      event: failureEvent({ postJobId: "job-9", userId: "user-1" }),
      error: new Error("step timed out"),
    });

    expect(failPendingMock).toHaveBeenCalledTimes(1);
    expect(failPendingMock).toHaveBeenCalledWith("job-9", {
      errorCode: "PUBLISH_INTERRUPTED",
      errorMessage: "Publishing was interrupted. Please retry.",
    });
  });

  it("does nothing (but logs) when the failed event carries no postJobId", async () => {
    await failInterruptedPublishRun({ event: failureEvent({}), error: new Error("boom") });
    expect(failPendingMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  // Fix round 1 (ruling R8b): a dead retry run fails ONLY the platforms its
  // own event re-queued. The original publish run (or another retry) may
  // still own the job's other pending results; failing those would let the
  // user retry a platform that is still being published -> double post.
  it("a failed retry run fails only the pending results of ITS OWN platforms", async () => {
    failPendingMock.mockResolvedValue({ failedCount: 1, status: "in_progress" });

    await failInterruptedRetryRun({
      event: failureEvent({ postJobId: "job-9", userId: "user-1", platforms: ["x", "tiktok"] }),
      error: new Error("step timed out"),
    });

    expect(failPendingMock).toHaveBeenCalledTimes(1);
    expect(failPendingMock).toHaveBeenCalledWith(
      "job-9",
      { errorCode: "PUBLISH_INTERRUPTED", errorMessage: "Publishing was interrupted. Please retry." },
      { platforms: ["x", "tiktok"] },
    );
  });

  it.each([
    ["no platforms field", { postJobId: "job-9" }],
    ["an empty platforms list", { postJobId: "job-9", platforms: [] }],
    ["no postJobId", { platforms: ["x"] }],
  ])("a failed retry run with %s touches nothing (but logs)", async (_label, data) => {
    await failInterruptedRetryRun({ event: failureEvent(data), error: new Error("boom") });
    expect(failPendingMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});

/**
 * Make one result's claim fail the way the database would: the conditional
 * claim write (resultClaim.ts) matches nothing, and the row then reads back as
 * `row` (null = the row is gone). Every other result is claimed normally.
 */
function loseClaimFor(
  resultId: string,
  row: { status: string; claimRunId: string | null } | null,
) {
  db.resultUpdateMany.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ count: where.id === resultId ? 0 : 1 }),
  );
  db.resultFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(
      where.id === resultId ? row : { status: "pending", claimRunId: null, socialConnectionId: null },
    ),
  );
}

/** The claim writes of this test (result id + the run that claimed), in call order. */
function claimWrites(): Array<{ id: string; claimRunId: unknown }> {
  return db.resultUpdateMany.mock.calls
    .map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> })
    .filter((arg) => "claimRunId" in arg.data)
    .map((arg) => ({ id: arg.where.id, claimRunId: arg.data.claimRunId }));
}

// Fix round 1 (ruling R8a), now enforced by the atomic claim (2026-11-01 scale
// audit, jobs H6): a retry step claims its PostJobResult when it starts and
// only publishes while the result is still `pending` and unclaimed. If an
// overlapping run already finalized it (or an onFailure handler failed it so
// the user could retry again), publishing would post twice.
describe("retryPlatforms — a retry step only publishes a still-pending result", () => {
  function retryRun(platforms: Platform[]) {
    return handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step: fakeStep(),
    }) as Promise<{ results: Array<{ platform: Platform; status: string }> }>;
  }

  beforeEach(() => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", perPlatformOverrides: null, deletedAt: null });
    db.connectionFindMany.mockResolvedValue([
      { id: "conn-x", platform: "x" },
      { id: "conn-youtube", platform: "youtube" },
    ]);
    stubResults(["x", "youtube"]);
  });

  it.each(["failed", "success"] as const)(
    "skips (no platform call, no result write) a result that is already %s",
    async (status) => {
      loseClaimFor("result-x", { status, claimRunId: null });

      const out = await retryRun(["x", "youtube"]);

      expect(db.resultUpdateMany).toHaveBeenCalledWith({
        where: { id: "result-x", status: "pending", claimRunId: null },
        data: CLAIM_DATA("run-1"),
      });
      expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["youtube"]);
      expect(db.resultUpdate.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id)).toEqual([
        "result-youtube",
      ]);
      expect(out.results).toEqual([
        { platform: "x", status: "skipped" },
        { platform: "youtube", status: "success" },
      ]);
    },
  );

  it("skips a result that no longer exists", async () => {
    loseClaimFor("result-x", null);

    const out = await retryRun(["x"]);

    expect(publishCtxs).toHaveLength(0);
    expect(db.resultUpdate).not.toHaveBeenCalled();
    expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
  });

  it("does not even write the no-connection failure over a result another run finalized", async () => {
    db.connectionFindMany.mockResolvedValue([]);
    loseClaimFor("result-x", { status: "success", claimRunId: "run-2" });

    await retryRun(["x"]);

    expect(db.resultUpdate).not.toHaveBeenCalled();
  });
});

// Final review M2: the publish-to-<platform> steps never re-checked their
// result. If `inngest.send` threw after Inngest had actually accepted the
// event (e.g. a response timeout), the route already failed the results
// (DISPATCH_FAILED) and answered 503 — yet the run still published, overwrote
// `failed` with `success`, and a user who pressed Retry (or re-posted) got a
// second post. Each step now claims its result like the R8a retry steps.
describe("publishToAllPlatforms — a publish step only publishes a still-pending result (M2)", () => {
  function publishRun(platforms: Platform[]) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    return handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
      },
      step: fakeStep(),
    }) as Promise<{ status: string; results: Array<{ platform: Platform; status: string }> }>;
  }

  beforeEach(() => {
    stubResults(["x", "youtube"]);
  });

  it.each(["failed", "success"] as const)(
    "skips (no platform call, no result write) a result that is already %s",
    async (status) => {
      loseClaimFor("result-x", { status, claimRunId: null });

      const out = await publishRun(["x", "youtube"]);

      expect(db.resultUpdateMany).toHaveBeenCalledWith({
        where: { id: "result-x", status: "pending", claimRunId: null },
        data: CLAIM_DATA("run-1"),
      });
      expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["youtube"]);
      expect(db.resultUpdate.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id)).toEqual([
        "result-youtube",
      ]);
      expect(out.results).toEqual([
        { platform: "x", status: "skipped" },
        { platform: "youtube", status: "success" },
      ]);
    },
  );

  it("skips a result that no longer exists", async () => {
    stubResults(["x"]);
    loseClaimFor("result-x", null);

    const out = await publishRun(["x"]);

    expect(publishCtxs).toHaveLength(0);
    expect(db.resultUpdate).not.toHaveBeenCalled();
    expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
  });

  it("publishes a result that is still pending", async () => {
    stubResults(["x"]);
    const out = await publishRun(["x"]);

    expect(claimWrites()).toEqual([{ id: "result-x", claimRunId: "run-1" }]);
    expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["x"]);
    expect(db.resultUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "result-x", claimRunId: "run-1", status: { in: ["pending", "failed"] } },
      }),
    );
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "success", externalPostId: "ext-x", ...HEARTBEAT }),
    ]);
    expect(out.results).toEqual([{ platform: "x", status: "success" }]);
  });

  it("finalize still recomputes the job from the DB when every step skipped (the route already failed them)", async () => {
    stubResults(["x", "youtube"], "failed");
    db.resultUpdateMany.mockResolvedValue({ count: 0 });
    db.resultFindUnique.mockResolvedValue({ status: "failed", claimRunId: null });

    const out = await publishRun(["x", "youtube"]);

    expect(publishCtxs).toHaveLength(0);
    expect(db.resultUpdate).not.toHaveBeenCalled();
    expect(db.postJobUpdate).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { status: "failed" } });
    expect(out.status).toBe("failed");
  });
});

type StoredResult = {
  status: string;
  claimRunId: string | null;
  socialConnectionId: string | null;
  deferredUntil?: Date | null;
  errorCode?: string | null;
};

function p2025() {
  return new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
    code: "P2025",
    clientVersion: "test",
  });
}

/**
 * An in-memory PostJobResult table behind the mocked prisma calls: the claim
 * write matches only a `pending` unclaimed row, a lost claim reads back the
 * row's real state, and a finalize write matches only the claim holder.
 */
function stubResultStore(seed: Record<string, Partial<StoredResult>>) {
  const rows = new Map<string, StoredResult>(
    Object.entries(seed).map(([id, row]) => [
      id,
      { status: "pending", claimRunId: null, socialConnectionId: null, ...row },
    ]),
  );
  db.resultUpdateMany.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.get(where.id);
      if (!row || !("claimRunId" in data)) return { count: 0 };
      if (row.status !== "pending" || row.claimRunId !== null) return { count: 0 };
      // The claim also clears a deferral (resultClaim.ts), so apply all of it.
      Object.assign(row, data);
      return { count: 1 };
    },
  );
  db.resultFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  });
  db.resultUpdate.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string; claimRunId: string; status: string | { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const row = rows.get(where.id);
      const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
      if (!row || row.claimRunId !== where.claimRunId || !allowed.includes(row.status)) {
        throw p2025();
      }
      // Applies a finalize (status, ...) and a deferral release (claim cleared,
      // deferredUntil set) alike; the nested job heartbeat is not a column.
      Object.assign(row, { ...data, postJob: undefined });
      return {};
    },
  );
  return rows;
}

// 2026-11-01 scale audit (jobs H6): every platform step CLAIMS its result row
// with one conditional write before it calls the platform. Two runs of one job
// - a duplicate event, a late original overlapping a retry - can therefore
// never both call the same platform, and a retried step (Task 2 raises the
// publish functions to retries: 3) finds its own claim and reports the post as
// unconfirmed instead of posting again.
describe("platform steps claim their result before calling the platform (jobs H6)", () => {
  type StepOut = { results: Array<{ platform: Platform; status: string; error?: string }> };

  function publishAs(runId: string) {
    return handlerOf(publishToAllPlatforms)({
      runId,
      event: {
        name: "post/publish.requested",
        data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
      },
      step: fakeStep(),
    }) as Promise<StepOut>;
  }

  function retryAs(runId: string) {
    return handlerOf(retryPlatforms)({
      runId,
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms: ["x"] } },
      step: fakeStep(),
    }) as Promise<StepOut>;
  }

  /** Hold the platform call open until `release()` so a second run can arrive mid-call. */
  function gatePlatformCall() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getPlatformClientMock.mockImplementation(() => ({
      publishVideo: vi.fn(async (ctx: PublishContext) => {
        publishCtxs.push(ctx);
        await gate;
        return { externalPostId: "ext-x" };
      }),
    }));
    return release;
  }

  beforeEach(() => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", perPlatformOverrides: null, deletedAt: null });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-x", platform: "x" }]);
    stubResults(["x"]);
  });

  it("two runs of the same job call the platform once - the second skips while the first is mid-call", async () => {
    stubResultStore({ "result-x": {} });
    const release = gatePlatformCall();

    const first = publishAs("run-1");
    await vi.waitFor(() => expect(publishCtxs).toHaveLength(1));
    const second = await publishAs("run-2");
    release();
    const firstOut = await first;

    expect(publishCtxs).toHaveLength(1);
    expect(claimWrites()).toEqual([
      { id: "result-x", claimRunId: "run-1" },
      { id: "result-x", claimRunId: "run-2" },
    ]);
    expect(second.results).toEqual([{ platform: "x", status: "skipped" }]);
    expect(firstOut.results).toEqual([{ platform: "x", status: "success" }]);
    // The skipping run never wrote the result.
    expect(db.resultUpdate).toHaveBeenCalledTimes(1);
    expect(db.resultUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "result-x", claimRunId: "run-1" }),
      }),
    );
  });

  it("two runs racing from the start still call the platform once", async () => {
    stubResultStore({ "result-x": {} });

    const outs = await Promise.all([publishAs("run-1"), publishAs("run-2")]);

    expect(publishCtxs).toHaveLength(1);
    expect(outs.map((o) => o.results[0].status).sort()).toEqual(["skipped", "success"]);
  });

  it.each([
    ["a retry run claims the result before the original run reaches its step", retryAs, publishAs],
    ["the original run claims the result before the retry run reaches its step", publishAs, retryAs],
  ])("%s: the first claimant publishes and the other skips", async (_label, firstRun, otherRun) => {
    stubResultStore({ "result-x": {} });
    const release = gatePlatformCall();

    const first = firstRun("run-first");
    await vi.waitFor(() => expect(publishCtxs).toHaveLength(1));
    const other = await otherRun("run-other");
    release();
    const firstOut = await first;

    expect(publishCtxs).toHaveLength(1);
    expect(other.results).toEqual([{ platform: "x", status: "skipped" }]);
    expect(firstOut.results).toEqual([{ platform: "x", status: "success" }]);
  });

  it("a step that finds its OWN claim (a dead earlier attempt) does not call the platform and records PUBLISH_UNCONFIRMED", async () => {
    stubResultStore({ "result-x": { claimRunId: "run-1" } });

    const out = await publishAs("run-1");

    expect(publishCtxs).toHaveLength(0);
    expect(db.resultUpdate).toHaveBeenCalledTimes(1);
    expect(db.resultUpdate).toHaveBeenCalledWith({
      where: { id: "result-x", claimRunId: "run-1", status: "pending" },
      data: {
        status: "failed",
        errorCode: "PUBLISH_UNCONFIRMED",
        errorMessage:
          "We couldn't confirm this post. It may already be live — check the platform before you retry.",
        ...CLEARS_STATE,
        ...HEARTBEAT,
      },
    });
    expect(out.results).toEqual([{ platform: "x", status: "failed", error: "Publish unconfirmed" }]);
  });

  it("does the same on the retry path", async () => {
    stubResultStore({ "result-x": { claimRunId: "run-1" } });

    const out = await retryAs("run-1");

    expect(publishCtxs).toHaveLength(0);
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "PUBLISH_UNCONFIRMED", ...HEARTBEAT }),
    ]);
    expect(out.results).toEqual([{ platform: "x", status: "failed", error: "Publish unconfirmed" }]);
  });

  it("does not throw when the claim is gone by the time the result is written (the post was already made)", async () => {
    stubResultStore({ "result-x": {} });
    db.resultUpdate.mockRejectedValue(p2025());

    const out = await publishAs("run-1");

    expect(publishCtxs).toHaveLength(1);
    expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    // Final review F6: the post is live but the row does not say so, so this is an
    // ERROR that carries the provider's post id (the only trace to reconcile by).
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("no longer holds its claim"),
      expect.objectContaining({ externalPostId: "ext-x", resultId: "result-x", runId: "run-1" }),
    );
  });

  // Fix round 1 (review Critical 2): the success write used to sit inside the
  // same try as the platform call. A DB error on that write (a pool timeout, a
  // dropped connection) fell into the catch, which recorded the LIVE post as a
  // retryable failure carrying the raw Prisma error - and a retry posts twice.
  // Now it propagates: the run fails, onFailure marks the claimed row
  // PUBLISH_UNCONFIRMED (and after Task 2 the step's retry finds its own claim
  // and does the same).
  it.each([
    ["publish step", publishAs],
    ["retry step", retryAs],
  ])("%s: a failing success write propagates and is never recorded as a retryable failure", async (_label, run) => {
    stubResultStore({ "result-x": {} });
    const poolTimeout = Object.assign(
      new Error("Timed out fetching a new connection from the connection pool"),
      { code: "P2024" },
    );
    db.resultUpdate.mockRejectedValue(poolTimeout);

    await expect(run("run-1")).rejects.toThrow("Timed out fetching a new connection");

    expect(publishCtxs).toHaveLength(1);
    // The one and only result write attempted was the success; no `failed` write
    // followed it.
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "success", externalPostId: "ext-x" }),
    ]);
  });

  it("claims before every write, including the failures that never reach the platform", async () => {
    stubResultStore({ "result-x": {} });
    getPlatformClientMock.mockImplementation(() => null);

    const out = await publishAs("run-1");

    expect(db.resultUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.resultUpdate.mock.invocationCallOrder[0],
    );
    expect(resultWrites()).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "CLIENT_NOT_FOUND", ...HEARTBEAT }),
    ]);
    expect(out.results).toEqual([{ platform: "x", status: "failed", error: "No client" }]);
  });
});

// Fix round 1 (review Important 1): the retry run's `fail-media-unavailable`
// step used to fail every `pending` row of its platforms with MEDIA_UNAVAILABLE,
// claimed or not - so a retry run that found the media gone overwrote a live
// claimant (the original run mid-call), whose success write then found nothing
// to update. It now goes through failPendingPostJobResults, which marks claimed
// rows PUBLISH_UNCONFIRMED and fails only the unclaimed ones with this reason.
describe("retryPlatforms — fail-media-unavailable (claim-aware)", () => {
  it.each([
    ["the media item is soft-deleted", { id: "media-1", baseCaption: "c", perPlatformOverrides: null, deletedAt: new Date() }],
    ["the media item is gone", null],
  ])("fails the re-queued platforms through the shared helper when %s", async (_label, media) => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue(media);
    db.connectionFindMany.mockResolvedValue([{ id: "conn-x", platform: "x" }]);
    stubResults(["x", "youtube"]);
    failPendingMock.mockResolvedValue({ failedCount: 1, unconfirmedCount: 0, status: "failed" });
    const step = fakeStep();

    const out = await handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms: ["x", "youtube"] } },
      step,
    });

    expect(step.run).toHaveBeenCalledWith("fail-media-unavailable", expect.any(Function));
    expect(failPendingMock).toHaveBeenCalledTimes(1);
    expect(failPendingMock).toHaveBeenCalledWith(
      "job-1",
      {
        errorCode: "MEDIA_UNAVAILABLE",
        errorMessage: "The media for this post is no longer available. Recreate the post.",
      },
      { platforms: ["x", "youtube"] },
    );
    // No direct, claim-blind write of its own, and nothing is published.
    expect(db.resultUpdateMany).not.toHaveBeenCalled();
    expect(db.postJobUpdate).not.toHaveBeenCalled();
    expect(publishCtxs).toHaveLength(0);
    expect(out).toEqual({ postJobId: "job-1", error: "Media unavailable" });
  });
});

// 2026-11-01 audit, Task 5: PostJobResult.socialConnectionId is nullable
// (onDelete: SetNull) so Disconnect / Switch account keep publish history. A
// retried result whose connection was removed has a null FK; the retry step
// publishes through the workspace's CURRENT connection for that platform and
// repoints the result to it, or — with no connection — fails the result with a
// clear not-connected error instead of throwing.
describe("retryPlatforms — a result whose connection was removed (Task 5)", () => {
  function retryRun(platforms: Platform[]) {
    return handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step: fakeStep(),
    }) as Promise<{ results: Array<{ platform: Platform; status: string; error?: string }> }>;
  }

  /** Make the repoint write fail (an FK violation); the claim write still succeeds. */
  function failRepointWrites() {
    db.resultUpdateMany.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      "socialConnectionId" in data
        ? Promise.reject(new Error("fk violation"))
        : Promise.resolve({ count: 1 }),
    );
  }

  /** Writes that point a result at a (new) connection — not status finalizes. */
  function repointWrites() {
    return db.resultUpdateMany.mock.calls
      .map((c) => c[0] as { where: unknown; data: Record<string, unknown> })
      .filter((arg) => "socialConnectionId" in arg.data);
  }

  beforeEach(() => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", perPlatformOverrides: null, deletedAt: null });
    stubResults(["x"]);
  });

  describe("when the workspace has reconnected the platform", () => {
    beforeEach(() => {
      db.connectionFindMany.mockResolvedValue([{ id: "conn-x-new", platform: "x" }]);
      db.connectionFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({ ...connectionRow("x"), id: where.id }),
      );
    });

    it.each([
      ["a null connection id (the connection was deleted)", null],
      ["an id of a connection that is no longer the workspace's", "conn-x-old"],
    ])("repoints a result with %s to the current connection and publishes through it", async (_label, staleId) => {
      db.resultFindUnique.mockResolvedValue({ status: "pending", socialConnectionId: staleId });

      const out = await retryRun(["x"]);

      expect(repointWrites()).toEqual([
        { where: { id: "result-x", status: "pending" }, data: { socialConnectionId: "conn-x-new" } },
      ]);
      expect(publishCtxs.map((c) => c.socialConnection.id)).toEqual(["conn-x-new"]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("does not rewrite a result that already points at the current connection", async () => {
      db.resultFindUnique.mockResolvedValue({ status: "pending", socialConnectionId: "conn-x-new" });

      const out = await retryRun(["x"]);

      expect(repointWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("still publishes when the repoint write itself fails (bookkeeping only)", async () => {
      db.resultFindUnique.mockResolvedValue({ status: "pending", socialConnectionId: null });
      failRepointWrites();

      const out = await retryRun(["x"]);

      expect(publishCtxs.map((c) => c.socialConnection.id)).toEqual(["conn-x-new"]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("reports a clean CONNECTION_GONE failure if the connection vanishes before the publish step", async () => {
      db.resultFindUnique.mockResolvedValue({ status: "pending", socialConnectionId: null });
      failRepointWrites();
      db.connectionFindUnique.mockResolvedValue(null);

      const out = await retryRun(["x"]);

      expect(publishCtxs).toHaveLength(0);
      expect(resultWrites()).toEqual([
        expect.objectContaining({ status: "failed", errorCode: "CONNECTION_GONE", ...HEARTBEAT }),
      ]);
      expect(out.results).toEqual([{ platform: "x", status: "failed", error: "Connection gone" }]);
    });
  });

  it("fails the result with a clear not-connected error — without throwing — when the platform has no connection", async () => {
    db.connectionFindMany.mockResolvedValue([]);
    db.resultFindUnique.mockResolvedValue({ status: "pending", socialConnectionId: null });

    const out = await retryRun(["x"]);

    expect(publishCtxs).toHaveLength(0);
    expect(repointWrites()).toEqual([]);
    expect(resultWrites()).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "RECONNECT_REQUIRED",
        errorMessage: "This platform is no longer connected. Reconnect it in Settings and try again.",
        ...HEARTBEAT,
      }),
    ]);
    expect(out.results).toEqual([{ platform: "x", status: "failed", error: "No connection" }]);
  });
});

// 2026-11-02 scale audit (correctness L1): Disconnect keeps the result rows
// (socialConnectionId -> NULL), but the publish run used to be planned from the
// workspace's CURRENT connections, so a result whose connection was removed after
// dispatch was never visited and stayed `pending` until the sweeps. The run is now
// planned from the result rows: each one publishes through its platform's current
// connection, and one with none is claimed and failed CONNECTION_GONE.
describe("publishToAllPlatforms - a result whose connection was removed after dispatch (correctness L1)", () => {
  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };
  const GONE_MESSAGE = "This platform connection was removed. Reconnect and retry.";

  type RunOut = {
    status?: string;
    error?: string;
    results?: Array<{ platform: Platform; status: string; error?: string }>;
  };

  /**
   * A run whose `fetch-data` sees `connections` (the workspace's connections now)
   * and `results` (the job's result rows, in row order; `socialConnectionId` is what
   * each row points at). The rows live in an in-memory table (stubResultStore), so
   * the claim, the finalize writes and the status recompute all see each other.
   */
  function setUpRun(args: {
    connections: Platform[];
    results: Array<[Platform, Partial<StoredResult>]>;
  }) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(
      args.connections.map((p) => ({ id: `conn-${p}`, platform: p })),
    );
    const rows = stubResultStore(
      Object.fromEntries(args.results.map(([platform, row]) => [`result-${platform}`, row])),
    );
    db.resultFindMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Promise.resolve(
        [...rows].map(([id, row]) =>
          select.platform
            ? { id, platform: id.slice("result-".length), socialConnectionId: row.socialConnectionId }
            : { status: row.status },
        ),
      ),
    );
    return rows;
  }

  function run(step = fakeStep()) {
    return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
  }

  /** The platform steps of a run, in order. */
  function platformSteps(step: FakeStep) {
    return step.order.filter((s) => s.startsWith("run:publish-to-"));
  }

  /** Writes that point a result at a (new) connection - not claims or finalizes. */
  function repointWrites() {
    return db.resultUpdateMany.mock.calls
      .map((c) => c[0] as { where: unknown; data: Record<string, unknown> })
      .filter((arg) => "socialConnectionId" in arg.data);
  }

  /** A fetch-data output as a run in flight before this change memoized it. */
  function stepReplaying(memoized: Record<string, unknown>) {
    const step = fakeStep();
    const live = step.run.getMockImplementation()!;
    step.run.mockImplementation(async (id: string, cb: () => unknown) => {
      if (!(id in memoized)) return live(id, cb);
      step.order.push(`run:${id}`);
      return memoized[id];
    });
    return step;
  }

  describe("one connection removed", () => {
    beforeEach(() => {
      setUpRun({
        connections: ["x"],
        results: [
          ["x", { socialConnectionId: "conn-x" }],
          ["linkedin", { socialConnectionId: null }],
        ],
      });
    });

    it("gives the removed platform's result its own publish step, after the connected ones", async () => {
      const step = fakeStep();

      await run(step);

      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-x",
        "run:publish-to-linkedin",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
    });

    it("claims it, makes no platform call, and finalizes it failed CONNECTION_GONE", async () => {
      const out = await run();

      expect(claimWrites()).toEqual([
        { id: "result-x", claimRunId: "run-1" },
        { id: "result-linkedin", claimRunId: "run-1" },
      ]);
      // Only X reached a platform; LinkedIn's connection was never even loaded.
      expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["x"]);
      expect(getPlatformClientMock).toHaveBeenCalledTimes(1);
      expect(db.connectionFindUnique).toHaveBeenCalledTimes(1);
      expect(resultWrites()).toEqual([
        expect.objectContaining({ status: "success", externalPostId: "ext-x", ...HEARTBEAT }),
        expect.objectContaining({
          status: "failed",
          errorCode: "CONNECTION_GONE",
          errorMessage: GONE_MESSAGE,
          ...HEARTBEAT,
        }),
      ]);
      expect(resultWrites()[1]).toMatchObject(CONNECTION_GONE_FAILURE);
      expect(out.results).toEqual([
        { platform: "x", status: "success" },
        { platform: "linkedin", status: "failed", error: "Connection gone" },
      ]);
    });

    it("finalizes the job completed (X went live) and sends the outcome email once", async () => {
      const step = fakeStep();

      const out = await run(step);

      expect(recomputeSpy).toHaveBeenCalledTimes(1);
      expect(db.postJobUpdate).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { status: "completed" } });
      expect(out.status).toBe("completed");
      expect(step.sendEvent).toHaveBeenCalledTimes(1);
      expect(step.sendEvent).toHaveBeenCalledWith("notify-outcome", expect.objectContaining({ id: "notify-job-1-run-1" }));
    });

    it("does not repoint it (there is no connection to point at)", async () => {
      await run();

      expect(repointWrites()).toEqual([]);
    });

    it("memoizes ids only: each result's id, platform and connection id, no tokens", async () => {
      const step = fakeStep();

      await run(step);

      expect(db.resultFindMany).toHaveBeenNthCalledWith(1, {
        where: { postJobId: "job-1" },
        select: { id: true, platform: true, socialConnectionId: true },
      });
      const fetched = step.outputs["fetch-data"] as { resultRecords: unknown; socialConnections: unknown };
      expect(fetched.socialConnections).toEqual([{ id: "conn-x", platform: "x" }]);
      expect(fetched.resultRecords).toEqual([
        { id: "result-x", platform: "x", socialConnectionId: "conn-x" },
        { id: "result-linkedin", platform: "linkedin", socialConnectionId: null },
      ]);
    });
  });

  describe("the order of the platform steps", () => {
    it("keeps today's connection order for results that have a connection", async () => {
      setUpRun({
        connections: ["linkedin", "x"],
        results: [
          ["x", { socialConnectionId: "conn-x" }],
          ["linkedin", { socialConnectionId: "conn-linkedin" }],
        ],
      });
      const step = fakeStep();

      await run(step);

      expect(platformSteps(step)).toEqual(["run:publish-to-linkedin", "run:publish-to-x"]);
    });

    it("puts results without a connection after those with one, in result order", async () => {
      setUpRun({
        connections: ["youtube"],
        results: [
          ["x", { socialConnectionId: null }],
          ["youtube", { socialConnectionId: "conn-youtube" }],
          ["linkedin", { socialConnectionId: null }],
          ["tiktok", { socialConnectionId: null }],
        ],
      });
      const step = fakeStep();

      const out = await run(step);

      expect(platformSteps(step)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-x",
        "run:publish-to-linkedin",
        "run:publish-to-tiktok",
      ]);
      expect(out.results?.map((r) => [r.platform, r.status])).toEqual([
        ["youtube", "success"],
        ["x", "failed"],
        ["linkedin", "failed"],
        ["tiktok", "failed"],
      ]);
    });

    it("replays an old-shape fetch-data output (connections and results alike, no connection ids) with today's ids", async () => {
      setUpRun({
        connections: ["x", "linkedin"],
        results: [
          ["x", { socialConnectionId: "conn-x" }],
          ["linkedin", { socialConnectionId: "conn-linkedin" }],
        ],
      });
      const step = stepReplaying({
        "fetch-data": {
          user: { id: "user-1" },
          workspace: WORKSPACE,
          mediaItem: { id: "media-1", baseCaption: "c", deletedAt: null },
          socialConnections: [
            { id: "conn-x", platform: "x" },
            { id: "conn-linkedin", platform: "linkedin" },
          ],
          resultRecords: [
            { id: "result-x", platform: "x" },
            { id: "result-linkedin", platform: "linkedin" },
          ],
        },
      });

      const out = await run(step);

      expect(db.postJobFindUnique).not.toHaveBeenCalled();
      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-x",
        "run:publish-to-linkedin",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["x", "linkedin"]);
      // The old shape cannot say what a result points at, so the step asks the
      // database - and finds nothing to repoint.
      expect(repointWrites()).toEqual([]);
      expect(out.status).toBe("completed");
    });
  });

  describe("every connection removed", () => {
    it.each([
      ["with result rows", [["x", { socialConnectionId: null }], ["linkedin", { socialConnectionId: null }]] as Array<[Platform, Partial<StoredResult>]>],
      ["with no result rows at all", [] as Array<[Platform, Partial<StoredResult>]>],
    ])("fails the job's pending results through failPendingPostJobResults %s", async (_label, results) => {
      setUpRun({ connections: [], results });
      const step = fakeStep();

      const out = await run(step);

      expect(step.order).toEqual(["run:fetch-data", "run:mark-failed-no-connections"]);
      expect(failPendingMock).toHaveBeenCalledTimes(1);
      expect(failPendingMock).toHaveBeenCalledWith("job-1", CONNECTION_GONE_FAILURE);
      expect(failPendingMock.mock.calls[0][1]).toEqual({
        errorCode: "CONNECTION_GONE",
        errorMessage: GONE_MESSAGE,
      });
      // The status is the helper's recompute, not a bare write of `failed`.
      expect(db.postJobUpdate).not.toHaveBeenCalled();
      expect(db.resultUpdate).not.toHaveBeenCalled();
      expect(publishCtxs).toHaveLength(0);
      expect(out).toEqual({ error: "No connections" });
    });

    it("sends no outcome email, as before", async () => {
      setUpRun({ connections: [], results: [["x", { socialConnectionId: null }]] });
      const step = fakeStep();

      await run(step);

      expect(step.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe("a result whose connection was replaced", () => {
    it.each([
      ["a null connection id (the old connection was deleted)", null],
      ["the id of a connection that is no longer the workspace's", "conn-x-old"],
    ])("repoints a result with %s at the current connection before publishing", async (_label, staleId) => {
      setUpRun({ connections: ["x"], results: [["x", { socialConnectionId: staleId }]] });

      const out = await run();

      expect(repointWrites()).toEqual([
        { where: { id: "result-x", status: "pending" }, data: { socialConnectionId: "conn-x" } },
      ]);
      const publishVideo = getPlatformClientMock.mock.results[0].value.publishVideo as ReturnType<typeof vi.fn>;
      expect(db.resultUpdateMany.mock.invocationCallOrder[1]).toBeLessThan(publishVideo.mock.invocationCallOrder[0]);
      expect(publishCtxs.map((c) => c.socialConnection.id)).toEqual(["conn-x"]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("does not rewrite a result that already points at the current connection", async () => {
      setUpRun({ connections: ["x"], results: [["x", { socialConnectionId: "conn-x" }]] });

      await run();

      // Nothing to look up either: the memoized fetch-data output already says so.
      expect(repointWrites()).toEqual([]);
      expect(db.resultFindUnique).not.toHaveBeenCalled();
    });

    it("does not repoint a result its claim lost (another run owns it)", async () => {
      setUpRun({
        connections: ["x"],
        results: [["x", { socialConnectionId: null, claimRunId: "run-other" }]],
      });

      const out = await run();

      expect(repointWrites()).toEqual([]);
      expect(publishCtxs).toHaveLength(0);
      expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
    });
  });

  describe("a result without a connection that is no longer claimable", () => {
    it("is skipped with nothing written when it already finished (the route failed it after a dispatch error)", async () => {
      setUpRun({
        connections: ["x"],
        results: [
          ["x", { socialConnectionId: "conn-x" }],
          ["linkedin", { socialConnectionId: null, status: "failed" }],
        ],
      });

      const out = await run();

      expect(out.results).toEqual([
        { platform: "x", status: "success" },
        { platform: "linkedin", status: "skipped" },
      ]);
      expect(resultWrites()).toHaveLength(1);
    });

    it("records PUBLISH_UNCONFIRMED, not CONNECTION_GONE, when the step meets its own earlier claim", async () => {
      // YouTube is still connected (so this is not the no-connections path) but has
      // no result row; X's connection is gone and its result is already claimed.
      setUpRun({
        connections: ["youtube"],
        results: [["x", { socialConnectionId: null, claimRunId: "run-1" }]],
      });

      const out = await run();

      expect(resultWrites()).toEqual([
        expect.objectContaining({ status: "failed", errorCode: "PUBLISH_UNCONFIRMED" }),
      ]);
      expect(out.results?.map((r) => [r.platform, r.status])).toEqual([["x", "failed"]]);
    });
  });
});

// 2026-11-01 scale audit (jobs H6 + H1 + M4): the publish functions' flow-control
// and retry options. `retries: 3` is safe because every platform step claims its
// result first (a retried platform step meets its own claim and records
// PUBLISH_UNCONFIRMED instead of calling the platform again), and the DB-only
// steps are idempotent reads / recomputes.
describe("publish functions - options (event identity, flow control, retries)", () => {
  const optsOf = (fn: unknown) => (fn as { opts: Record<string, unknown> }).opts;

  it("publishToAllPlatforms: retries 3, one run per postJobId, shared concurrency, Post-now priority", () => {
    const opts = optsOf(publishToAllPlatforms);

    expect(opts.id).toBe("publish-to-all-platforms");
    expect(opts.retries).toBe(3);
    expect(opts.idempotency).toBe("event.data.postJobId");
    expect(opts.concurrency).toEqual(publishConcurrency());
    expect(opts.priority).toEqual(PUBLISH_PRIORITY);
    // Inngest allows at most two concurrency constraints per function (V3).
    expect((opts.concurrency as unknown[]).length).toBeLessThanOrEqual(2);
    expect(opts.onFailure).toBe(failInterruptedPublishRun);
  });

  it("retryPlatforms: retries 3 and the same shared concurrency, no idempotency and no postJobId key", () => {
    const opts = optsOf(retryPlatforms);

    expect(opts.id).toBe("retry-platforms");
    expect(opts.retries).toBe(3);
    expect(opts.concurrency).toEqual(publishConcurrency());
    expect((opts.concurrency as unknown[]).length).toBeLessThanOrEqual(2);
    // A function-level key would swallow a legitimate second retry of one job;
    // the per-request event id already dedupes a re-send of the same request.
    expect(opts).not.toHaveProperty("idempotency");
    expect(JSON.stringify(opts.concurrency)).not.toContain("postJobId");
    expect(opts.onFailure).toBe(failInterruptedRetryRun);
  });

  it("publish and retry draw on the SAME env-scoped keys, so they share one budget", () => {
    const keys = (fn: unknown) =>
      (optsOf(fn).concurrency as Array<{ scope: string; key: string }>).map(({ scope, key }) => [scope, key]);

    expect(keys(publishToAllPlatforms)).toEqual(keys(retryPlatforms));
    expect(keys(publishToAllPlatforms)).toEqual([
      ["env", '"publish-ws-" + event.data.workspaceId'],
      ["env", '"publish-global"'],
    ]);
  });
});

describe("publish functions - deterministic failures are not retried", () => {
  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };

  it("fetch-data throws a NonRetriableError when the job is gone", async () => {
    db.postJobFindUnique.mockResolvedValue(null);

    const error = await handlerOf(publishToAllPlatforms)({ event: publishEvent, step: fakeStep() }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NonRetriableError);
    expect((error as Error).message).toBe("Missing required data");
  });

  it.each([
    ["user", () => db.userFindUnique.mockResolvedValue(null)],
    ["workspace", () => db.workspaceFindUnique.mockResolvedValue(null)],
    ["media item", () => db.mediaItemFindUnique.mockResolvedValue(null)],
  ])("fetch-data throws a NonRetriableError when the %s is gone", async (_what, remove) => {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue([]);
    db.resultFindMany.mockResolvedValue([]);
    remove();

    await expect(
      handlerOf(publishToAllPlatforms)({ event: publishEvent, step: fakeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("a transient database error in fetch-data stays retryable", async () => {
    db.postJobFindUnique.mockRejectedValue(new Error("Timed out fetching a new connection from the pool"));

    const error = await handlerOf(publishToAllPlatforms)({ event: publishEvent, step: fakeStep() }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
  });
});

describe("publish functions - finalize through the locked recompute, notify with a run-scoped id", () => {
  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };

  function publishRun(platforms: Platform[], step = fakeStep(), event: HandlerArgs["event"] = publishEvent) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(publishToAllPlatforms)({ event, step }) as Promise<{
      status: string;
      results: Array<{ platform: Platform; status: string }>;
    }>;
  }

  function retryRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null, mimeType: "video/mp4" });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step,
    }) as Promise<{ status: string }>;
  }

  it("finalize-job recomputes through recomputeAndStorePostJobStatus, under the PostJob row lock", async () => {
    const step = fakeStep();

    const out = await publishRun(["x", "youtube"], step);

    expect(step.run).toHaveBeenCalledWith("finalize-job", expect.any(Function));
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(recomputeSpy).toHaveBeenCalledWith("job-1");
    // The lock is the transaction's first statement, before the status write.
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.postJobUpdate.mock.invocationCallOrder[0]);
    expect(db.postJobUpdate).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { status: "completed" } });
    expect(out.status).toBe("completed");
  });

  it("finalize-retry recomputes through recomputeAndStorePostJobStatus, under the PostJob row lock", async () => {
    const step = fakeStep();

    const out = await retryRun(["x", "youtube"], step);

    expect(step.run).toHaveBeenCalledWith("finalize-retry", expect.any(Function));
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(recomputeSpy).toHaveBeenCalledWith("job-1");
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.postJobUpdate.mock.invocationCallOrder[0]);
    expect(db.postJobUpdate).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { status: "completed" } });
    expect(out.status).toBe("completed");
  });

  it("a failed recompute fails the step, so Inngest retries it (it is idempotent)", async () => {
    recomputeSpy.mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"));

    await expect(publishRun(["x"])).rejects.toThrow(/pool/);
  });

  it("notify-outcome carries a run-scoped event id (publish)", async () => {
    const step = fakeStep();

    await publishRun(["x"], step);

    expect(step.sendEvent).toHaveBeenCalledWith("notify-outcome", {
      id: "notify-job-1-run-1",
      name: "notification.requested",
      data: { userId: "user-1", postJobId: "job-1" },
    });
  });

  it("notify-outcome carries a run-scoped event id (retry)", async () => {
    const step = fakeStep();

    await retryRun(["x"], step);

    expect(step.sendEvent).toHaveBeenCalledWith("notify-outcome", {
      id: "notify-job-1-run-1",
      name: "notification.requested",
      data: { userId: "user-1", postJobId: "job-1" },
    });
  });

  it("a different run of the same job notifies under its own id (a retry is a new outcome)", async () => {
    const step = fakeStep();
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-x", platform: "x" }]);
    stubResults(["x"]);

    await (publishToAllPlatforms as unknown as {
      fn: (args: HandlerArgs) => Promise<unknown>;
    }).fn({ event: publishEvent, step, runId: "run-2" });

    expect(step.sendEvent).toHaveBeenCalledWith(
      "notify-outcome",
      expect.objectContaining({ id: "notify-job-1-run-2" }),
    );
  });

  // Review Focus 3: events enqueued BEFORE this deploy have no `workspaceId`,
  // no `immediate` and no event id. Their runs must still publish every platform
  // exactly once: the handler takes the workspace from the job row, never from
  // the event, and nothing in it reads the new fields.
  it("an event without workspaceId, immediate or an id (the pre-deploy shape) still publishes every platform exactly once", async () => {
    const platforms: Platform[] = ["x", "youtube", "tiktok"];
    const legacyEvent = {
      name: "post/publish.requested",
      data: {
        postJobId: "job-1",
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "c",
        perPlatformOverrides: null,
      },
    };
    expect(legacyEvent).not.toHaveProperty("id");
    expect(legacyEvent.data).not.toHaveProperty("workspaceId");
    expect(legacyEvent.data).not.toHaveProperty("immediate");

    const out = await publishRun(platforms, fakeStep(), legacyEvent);

    expect(publishCtxs.map((c) => c.socialConnection.platform).sort()).toEqual([...platforms].sort());
    expect(out.results).toEqual(platforms.map((platform) => ({ platform, status: "success" })));
    expect(out.status).toBe("completed");
  });

  it("an old retry event (no workspaceId) still retries its platforms exactly once", async () => {
    const out = await retryRun(["x", "youtube"]);

    expect(publishCtxs.map((c) => c.socialConnection.platform).sort()).toEqual(["x", "youtube"]);
    expect(out.status).toBe("completed");
  });
});

// 2026-11-01 scale audit (platform limits): a platform that answers with a rate
// limit or quota refusal no longer fails its result. The step hands its claim
// back, the result stays `pending` with `deferredUntil`, and the RUN sleeps
// (`step.sleepUntil` frees the concurrency slot) before trying that platform
// again; the platforms that are not limited publish first.
describe("platform rate limits - durable deferral (platform limits)", () => {
  const T = Date.parse("2026-11-02T10:00:00.000Z");
  const HOUR = 3_600_000;
  const GRACE = 300_000;

  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };

  /** The platforms' `publishVideo` behaviour, by call: anything unlisted succeeds. */
  function platformCalls(impls: Partial<Record<Platform, (call: number) => Promise<unknown> | unknown>>) {
    const calls: Partial<Record<Platform, number>> = {};
    getPlatformClientMock.mockImplementation((platform: Platform) => ({
      publishVideo: vi.fn(async (ctx: PublishContext) => {
        publishCtxs.push(ctx);
        const call = (calls[platform] = (calls[platform] ?? 0) + 1);
        const impl = impls[platform];
        return impl ? impl(call) : { externalPostId: `ext-${platform}` };
      }),
    }));
    return calls;
  }

  type RunOut = {
    status: string;
    results: Array<{ platform: Platform; status: string; error?: string }>;
  };

  function publishRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
  }

  function retryRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null, mimeType: "video/mp4" });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step,
    }) as Promise<RunOut>;
  }

  type RateLimitKindName = "rate_limited" | "daily_limit" | "youtube_quota";
  const limited = (platform: Platform, retryAt: number | null, kind: RateLimitKindName = "rate_limited") =>
    rateLimitedError(platform, kind, retryAt);

  const failedWrites = () => resultWrites().filter((w) => w.status === "failed");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a rate-limited platform step", () => {
    it("is not failed: its claim is released with the platform's retryAt and the step reports it deferred", async () => {
      platformCalls({
        x: (call) => {
          if (call === 1) throw limited("x", T + 2 * HOUR);
          return { externalPostId: "ext-x" };
        },
      });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      // No failed finalize anywhere.
      expect(failedWrites()).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith("result-x", "run-1", {
        until: new Date(T + 2 * HOUR),
        errorCode: "RATE_LIMITED",
      });
      // ...and the release itself is the one conditional write that records it.
      expect(db.resultUpdate.mock.calls[0][0]).toEqual({
        where: { id: "result-x", claimRunId: "run-1", status: "pending" },
        data: {
          claimRunId: null,
          claimedAt: null,
          deferredUntil: new Date(T + 2 * HOUR),
          errorCode: "RATE_LIMITED",
          errorMessage: null,
          ...HEARTBEAT,
        },
      });
      // The step's (memoized) output is the deferral: platform, status, ISO retryAt. No secrets.
      expect(step.outputs["publish-to-x"]).toEqual({
        platform: "x",
        status: "deferred",
        retryAt: new Date(T + 2 * HOUR).toISOString(),
      });
      // The run then waits for it and publishes.
      expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-x-wait-rl1", new Date(T + 2 * HOUR));
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("waits out the backoff schedule when the platform gave no retryAt", async () => {
      platformCalls({
        x: (call) => {
          if (call <= 3) throw limited("x", null);
          return { externalPostId: "ext-x" };
        },
      });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(releaseSpy.mock.calls.map((c) => (c[2] as { until: Date }).until.getTime())).toEqual([
        T + 60_000,
        T + 900_000,
        T + 3_600_000,
      ]);
      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-x",
        "sleepUntil:publish-to-x-wait-rl1",
        "run:publish-to-x-rl1",
        "sleepUntil:publish-to-x-wait-rl2",
        "run:publish-to-x-rl2",
        "sleepUntil:publish-to-x-wait-rl3",
        "run:publish-to-x-rl3",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("gives up on the 4th consecutive limit (attempt 3): finalized failed RATE_LIMITED with the give-up copy", async () => {
      const calls = platformCalls({
        x: () => {
          throw limited("x", T + 2 * HOUR);
        },
      });
      stubResultStore({ "result-x": {} });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(4);
      expect(releaseSpy).toHaveBeenCalledTimes(3);
      expect(step.order.filter((entry) => entry.startsWith("sleepUntil:"))).toEqual([
        "sleepUntil:publish-to-x-wait-rl1",
        "sleepUntil:publish-to-x-wait-rl2",
        "sleepUntil:publish-to-x-wait-rl3",
      ]);
      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "RATE_LIMITED",
          errorMessage: "X kept rate-limiting this post. Retry this platform later.",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
      expect(db.resultUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: "result-x", claimRunId: "run-1", status: "pending" } }),
      );
      expect(out.results).toEqual([
        { platform: "x", status: "failed", error: "X kept rate-limiting this post. Retry this platform later." },
      ]);
    });

    it("waits for a platform that asks for 25 hours (the cap is 26 h, ruling R23)", async () => {
      platformCalls({
        x: (call) => {
          if (call === 1) throw limited("x", T + 25 * HOUR);
          return { externalPostId: "ext-x" };
        },
      });

      const out = await publishRun(["x"]);

      expect(releaseSpy).toHaveBeenCalledWith("result-x", "run-1", {
        until: new Date(T + 25 * HOUR),
        errorCode: "RATE_LIMITED",
      });
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("gives up at once, finalized failed, when the platform asks to wait more than 26 hours", async () => {
      const calls = platformCalls({
        x: () => {
          throw limited("x", T + 27 * HOUR);
        },
      });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(1);
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(failedWrites()).toEqual([
        expect.objectContaining({
          errorCode: "RATE_LIMITED",
          errorMessage: "X kept rate-limiting this post. Retry this platform later.",
        }),
      ]);
      expect(out.results[0].status).toBe("failed");
    });

    it("clamps a retryAt that is nearly due to 30 seconds from now", async () => {
      platformCalls({
        x: (call) => {
          if (call === 1) throw limited("x", T + 5_000);
          return { externalPostId: "ext-x" };
        },
      });

      await publishRun(["x"]);

      expect(releaseSpy).toHaveBeenCalledWith("result-x", "run-1", {
        until: new Date(T + 30_000),
        errorCode: "RATE_LIMITED",
      });
    });

    it.each(["x", "tiktok", "linkedin", "instagram"] as const)(
      "defers %s the same way (TikTok's creator-info refusal is rethrown by its client as the same error)",
      async (platform) => {
        platformCalls({
          [platform]: (call: number) => {
            if (call === 1) throw limited(platform, T + HOUR);
            return { externalPostId: `ext-${platform}` };
          },
        });

        const out = await publishRun([platform]);

        expect(releaseSpy).toHaveBeenCalledWith(`result-${platform}`, "run-1", {
          until: new Date(T + HOUR),
          errorCode: "RATE_LIMITED",
        });
        expect(failedWrites()).toEqual([]);
        expect(out.results).toEqual([{ platform, status: "success" }]);
      },
    );

    it("records DAILY_LIMIT for a daily_limit refusal (Instagram's 100 posts per 24 h)", async () => {
      platformCalls({
        instagram: (call) => {
          if (call === 1) throw limited("instagram", T + 23 * HOUR, "daily_limit");
          return { externalPostId: "ext-instagram" };
        },
      });

      await publishRun(["instagram"]);

      expect(releaseSpy).toHaveBeenCalledWith("result-instagram", "run-1", {
        until: new Date(T + 23 * HOUR),
        errorCode: "DAILY_LIMIT",
      });
    });

    it("finalizes failed DAILY_LIMIT with its own give-up copy when a daily limit never lifts", async () => {
      platformCalls({
        instagram: () => {
          throw limited("instagram", T + 23 * HOUR, "daily_limit");
        },
      });

      await publishRun(["instagram"]);

      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "DAILY_LIMIT",
          errorMessage: "Instagram's daily limit is still reached. Retry this platform later.",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
    });

    it("is skipped, with no sleep, when the claim it held is gone by the time it is released", async () => {
      platformCalls({
        x: () => {
          throw limited("x", T + HOUR);
        },
      });
      stubResultStore({ "result-x": {} });
      // Something else failed the result meanwhile (the reconciler, an onFailure handler).
      db.resultUpdate.mockRejectedValue(p2025());
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
    });
  });

  describe("the YouTube upload budget", () => {
    it("is spent after the claim and before the upload, and only for YouTube", async () => {
      platformCalls({});

      await publishRun(["x", "youtube"]);

      expect(consumeSlotMock).toHaveBeenCalledTimes(1);
      // updateMany calls: x's claim, youtube's claim.
      const youtubeClaim = db.resultUpdateMany.mock.invocationCallOrder[1];
      const slot = consumeSlotMock.mock.invocationCallOrder[0];
      const youtubeUpload = publishCtxs.findIndex((c) => c.socialConnection.platform === "youtube");
      expect(youtubeUpload).toBeGreaterThanOrEqual(0);
      expect(youtubeClaim).toBeLessThan(slot);
      // youtube's success write comes after the slot was taken
      expect(slot).toBeLessThan(db.resultUpdate.mock.invocationCallOrder[1]);
    });

    it("refuses without calling the API when today's budget is spent: deferred to the reset plus the grace, as a daily limit", async () => {
      const resetAt = new Date(T + 14 * HOUR);
      consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt });
      const calls = platformCalls({});
      const step = fakeStep();

      const out = await publishRun(["youtube"], step);

      // Only the second attempt (after the sleep) uploaded.
      expect(calls.youtube).toBe(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
        until: new Date(resetAt.getTime() + GRACE),
        errorCode: "DAILY_LIMIT",
      });
      expect(step.outputs["publish-to-youtube"]).toEqual({
        platform: "youtube",
        status: "deferred",
        retryAt: new Date(resetAt.getTime() + GRACE).toISOString(),
      });
      expect(failedWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
    });

    it("does not call publishVideo at all while the budget stays spent, then gives up as DAILY_LIMIT", async () => {
      consumeSlotMock.mockResolvedValue({ allowed: false, resetAt: new Date(T + 14 * HOUR) });
      const calls = platformCalls({});

      const out = await publishRun(["youtube"]);

      expect(calls.youtube).toBeUndefined();
      expect(consumeSlotMock).toHaveBeenCalledTimes(4);
      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "DAILY_LIMIT",
          errorMessage: "YouTube's daily limit is still reached. Retry this platform later.",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
      expect(out.results[0].status).toBe("failed");
      // The refusal came from our own counter, which is already spent.
      expect(exhaustBudgetMock).not.toHaveBeenCalled();
    });

    it("gives up (rather than sleeping past the 26 h cap) when the budget resets more than 26 h away", async () => {
      consumeSlotMock.mockResolvedValue({ allowed: false, resetAt: new Date(T + 27 * HOUR) });
      platformCalls({});
      const step = fakeStep();

      await publishRun(["youtube"], step);

      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(failedWrites()).toEqual([expect.objectContaining({ errorCode: "DAILY_LIMIT" })]);
    });

    it("marks today's budget used up when YouTube itself reports quotaExceeded (once per error)", async () => {
      platformCalls({
        youtube: (call) => {
          if (call === 1) throw limited("youtube", T + 14 * HOUR + GRACE, "youtube_quota");
          return { externalPostId: "ext-youtube" };
        },
      });

      await publishRun(["youtube"]);

      expect(exhaustBudgetMock).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
        until: new Date(T + 14 * HOUR + GRACE),
        errorCode: "DAILY_LIMIT",
      });
    });

    it("does not trip the budget for a plain YouTube rate limit", async () => {
      platformCalls({
        youtube: (call) => {
          if (call === 1) throw limited("youtube", T + HOUR, "rate_limited");
          return { externalPostId: "ext-youtube" };
        },
      });

      await publishRun(["youtube"]);

      expect(exhaustBudgetMock).not.toHaveBeenCalled();
      expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
        until: new Date(T + HOUR),
        errorCode: "RATE_LIMITED",
      });
    });

    it("spends ONE slot per attempt even when withTransientRetries retries the call in-step", async () => {
      platformCalls({
        youtube: (call) => {
          if (call === 1) throw Object.assign(new Error("busy"), { status: 503 });
          return { externalPostId: "ext-youtube" };
        },
      });

      const run = publishRun(["youtube"]);
      await vi.advanceTimersByTimeAsync(2_000); // the 2 s in-step backoff
      const out = await run;

      expect(publishCtxs).toHaveLength(2);
      expect(consumeSlotMock).toHaveBeenCalledTimes(1);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
    });

    it("is not spent for a result that fails before reaching the platform (no connection)", async () => {
      platformCalls({});
      db.connectionFindUnique.mockResolvedValue(null);

      await publishRun(["youtube"]);

      expect(consumeSlotMock).not.toHaveBeenCalled();
    });

    // Ruling R23 (b): Google's quota resets at midnight Pacific, but its clock may
    // lag ours by a few minutes. A quotaExceeded in the first 5 minutes of the
    // Pacific day is that lag, not a spent budget: it must not trip the NEW day's
    // counter (which would block every workspace for a day), and the wait is only
    // until the day's own reset plus the grace.
    describe("an early-morning refusal is Google's reset lagging (ruling R23)", () => {
      /** The next Pacific midnight plus the grace, as the classifier sets a quota error's retryAt. */
      const classifierRetryAt = (nowIso: string) =>
        nextPacificMidnight(new Date(nowIso)).getTime() + GRACE;

      it("Google's 403 quotaExceeded at 00:02 PST: no exhaust call, deferred to 00:05 PST today", async () => {
        const now = "2026-11-02T08:02:00Z";
        vi.setSystemTime(Date.parse(now));
        platformCalls({
          youtube: (call) => {
            if (call === 1) throw limited("youtube", classifierRetryAt(now), "youtube_quota");
            return { externalPostId: "ext-youtube" };
          },
        });
        const step = fakeStep();

        const out = await publishRun(["youtube"], step);

        // The classifier would have said tomorrow 00:05 PST (2026-11-03T08:05Z).
        expect(classifierRetryAt(now)).toBe(Date.parse("2026-11-03T08:05:00Z"));
        expect(exhaustBudgetMock).not.toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
          until: new Date("2026-11-02T08:05:00Z"),
          errorCode: "DAILY_LIMIT",
        });
        expect(step.sleepUntil).toHaveBeenCalledWith(
          "publish-to-youtube-wait-rl1",
          new Date("2026-11-02T08:05:00Z"),
        );
        expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
      });

      it("keeps the 30 s minimum wait when the lag window is nearly over", async () => {
        const now = "2026-11-02T08:04:50Z";
        vi.setSystemTime(Date.parse(now));
        platformCalls({
          youtube: (call) => {
            if (call === 1) throw limited("youtube", classifierRetryAt(now), "youtube_quota");
            return { externalPostId: "ext-youtube" };
          },
        });

        await publishRun(["youtube"]);

        expect(exhaustBudgetMock).not.toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
          until: new Date("2026-11-02T08:05:20Z"), // now + 30 s, not 08:05:00
          errorCode: "DAILY_LIMIT",
        });
      });

      it("our own budget refusal at 00:02 PST is treated the same way", async () => {
        const now = "2026-11-02T08:02:00Z";
        vi.setSystemTime(Date.parse(now));
        consumeSlotMock.mockResolvedValueOnce({
          allowed: false,
          resetAt: nextPacificMidnight(new Date(now)),
        });
        platformCalls({});

        await publishRun(["youtube"]);

        expect(exhaustBudgetMock).not.toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
          until: new Date("2026-11-02T08:05:00Z"),
          errorCode: "DAILY_LIMIT",
        });
      });

      it("from 00:05 PST on, a quotaExceeded is real: it trips the counter and waits for tomorrow's reset", async () => {
        const now = "2026-11-02T08:05:00Z";
        vi.setSystemTime(Date.parse(now));
        platformCalls({
          youtube: (call) => {
            if (call === 1) throw limited("youtube", classifierRetryAt(now), "youtube_quota");
            return { externalPostId: "ext-youtube" };
          },
        });

        await publishRun(["youtube"]);

        expect(exhaustBudgetMock).toHaveBeenCalledTimes(1);
        expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
          until: new Date("2026-11-03T08:05:00Z"),
          errorCode: "DAILY_LIMIT",
        });
      });

      it("only a youtube_quota refusal is affected: a plain rate limit and a channel upload limit keep their retryAt", async () => {
        const now = "2026-11-02T08:02:00Z";
        vi.setSystemTime(Date.parse(now));
        const rateLimitedAt = Date.parse("2026-11-02T08:10:00Z");
        const channelResetAt = classifierRetryAt(now);
        const outcomes: Array<[RateLimitKindName, number]> = [];
        for (const [kind, retryAt] of [
          ["rate_limited", rateLimitedAt],
          ["daily_limit", channelResetAt],
        ] as const) {
          releaseSpy.mockClear();
          platformCalls({
            youtube: (call) => {
              if (call === 1) throw limited("youtube", retryAt, kind);
              return { externalPostId: "ext-youtube" };
            },
          });
          await publishRun(["youtube"]);
          outcomes.push([
            kind,
            (releaseSpy.mock.calls[0][2] as { until: Date }).until.getTime(),
          ]);
        }

        expect(outcomes).toEqual([
          ["rate_limited", rateLimitedAt],
          ["daily_limit", channelResetAt],
        ]);
        expect(exhaustBudgetMock).not.toHaveBeenCalled();
      });
    });

    // Ruling R23 (a): the next reset can be 25 h 35 min away on the fall-back day;
    // a woken overnight backlog must wait for it, not fail.
    it("on the fall-back day, a refusal at 00:30 PDT waits for the next reset plus the grace and does not give up", async () => {
      vi.setSystemTime(Date.parse("2027-11-07T07:30:00Z"));
      const resetAt = nextPacificMidnight(new Date("2027-11-07T07:30:00Z"));
      expect(resetAt.toISOString()).toBe("2027-11-08T08:00:00.000Z");
      consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt });
      const calls = platformCalls({});
      const step = fakeStep();

      const out = await publishRun(["youtube"], step);

      // The wait is longer than a day, so the old 24 h cap would have failed it.
      const until = new Date("2027-11-08T08:05:00Z");
      expect(until.getTime() - Date.parse("2027-11-07T07:30:00Z")).toBeGreaterThan(24 * HOUR);
      expect(releaseSpy).toHaveBeenCalledWith("result-youtube", "run-1", {
        until,
        errorCode: "DAILY_LIMIT",
      });
      expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-youtube-wait-rl1", until);
      expect(failedWrites()).toEqual([]);
      expect(exhaustBudgetMock).not.toHaveBeenCalled();
      expect(calls.youtube).toBe(1);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
    });
  });

  // Review Focus 2: a YouTube result deferred ~20 h while the job's other
  // platforms already finished.
  describe("Review Focus 2 - overnight deferral", () => {
    it("X succeeds, YouTube defers ~20 h and then succeeds: one outcome email, after finalize-job, which follows publish-to-youtube-rl1", async () => {
      const resetAt = new Date(T + 20 * HOUR);
      consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt });
      platformCalls({});
      const rows = stubResultStore({ "result-x": {}, "result-youtube": {} });
      const step = fakeStep();
      // What the youtube row looks like while the run sleeps.
      let whileSleeping: unknown;
      step.sleepUntil.mockImplementation(async (id: string) => {
        step.order.push(`sleepUntil:${id}`);
        whileSleeping = { ...rows.get("result-youtube") };
      });

      const out = await publishRun(["x", "youtube"], step);

      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-x",
        "run:publish-to-youtube",
        "sleepUntil:publish-to-youtube-wait-rl1",
        "run:publish-to-youtube-rl1",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      expect(step.sendEvent).toHaveBeenCalledTimes(1);
      // While asleep: still pending, holding no claim (so no PUBLISH_UNCONFIRMED
      // mark can apply), with the instant it waits for.
      expect(whileSleeping).toMatchObject({
        status: "pending",
        claimRunId: null,
        deferredUntil: new Date(resetAt.getTime() + GRACE),
        errorCode: "DAILY_LIMIT",
      });
      // After the wake-up the claim ended the deferral and the post went out.
      expect(rows.get("result-youtube")).toMatchObject({
        status: "success",
        claimRunId: "run-1",
        deferredUntil: null,
        errorCode: null,
      });
      expect(rows.get("result-x")).toMatchObject({ status: "success" });
      expect(out.results).toEqual([
        { platform: "x", status: "success" },
        { platform: "youtube", status: "success" },
      ]);
    });

    it("a sleeping YouTube never delays the other platforms: they all publish in the first pass", async () => {
      consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt: new Date(T + 20 * HOUR) });
      platformCalls({});
      const step = fakeStep();

      await publishRun(["youtube", "x", "linkedin"], step);

      expect(step.order.slice(1)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-x",
        "run:publish-to-linkedin",
        "sleepUntil:publish-to-youtube-wait-rl1",
        "run:publish-to-youtube-rl1",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
    });

    it("the same holds for the retry function: retry-youtube keeps its id, then -wait-rl1 and -rl1, then finalize-retry and one email", async () => {
      consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt: new Date(T + 20 * HOUR) });
      platformCalls({});
      const step = fakeStep();

      await retryRun(["x", "youtube"], step);

      expect(step.order).toEqual([
        "run:fetch-retry-data",
        "run:retry-x",
        "run:retry-youtube",
        "sleepUntil:retry-youtube-wait-rl1",
        "run:retry-youtube-rl1",
        "run:finalize-retry",
        "sendEvent:notify-outcome",
      ]);
      expect(step.sendEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("resuming after a sleep", () => {
    it("bumps the job's heartbeat BEFORE claiming again, so the sweeps cannot take a run that just woke up", async () => {
      platformCalls({
        x: (call) => {
          if (call === 1) throw limited("x", T + 20 * HOUR);
          return { externalPostId: "ext-x" };
        },
      });

      await publishRun(["x"]);

      // Not on the first attempt (the previous step's heartbeat is fresh)...
      expect(db.postJobUpdateMany).toHaveBeenCalledTimes(1);
      expect(db.postJobUpdateMany).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { updatedAt: expect.any(Date) },
      });
      // ...only on the attempt after the sleep, and before that attempt's claim.
      const claimCalls = db.resultUpdateMany.mock.invocationCallOrder;
      expect(claimCalls).toHaveLength(2);
      expect(db.postJobUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(claimCalls[0]);
      expect(db.postJobUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(claimCalls[1]);
    });

    it("a heartbeat failure is logged and does not stop the attempt", async () => {
      platformCalls({
        x: (call) => {
          if (call === 1) throw limited("x", T + HOUR);
          return { externalPostId: "ext-x" };
        },
      });
      db.postJobUpdateMany.mockRejectedValue(new Error("pool timeout"));

      const out = await publishRun(["x"]);

      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
      expect(console.warn).toHaveBeenCalled();
    });

    it("skips (no platform call) when the result was failed meanwhile and so is no longer claimable", async () => {
      const calls = platformCalls({
        x: () => {
          throw limited("x", T + HOUR);
        },
      });
      stubResultStore({ "result-x": {} });
      const step = fakeStep();
      // While the run sleeps the reconciler gives up on the (old) job.
      step.sleepUntil.mockImplementation(async (id: string) => {
        step.order.push(`sleepUntil:${id}`);
        db.resultUpdateMany.mockResolvedValue({ count: 0 });
        db.resultFindUnique.mockResolvedValue({ status: "failed", claimRunId: null });
      });

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(1);
      expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
    });
  });
});

// 2026-11-02 scale audit (jobs, chunked uploads): a platform step that made
// progress on a large upload but has more to do reports `continue`. It hands its
// claim back (the same write bumps the job heartbeat, no deferral is recorded)
// and the run calls it again in `<stepId>-c<n>`, optionally after a durable sleep.
// The saved upload state is the only thing that crosses the step boundary.
describe("chunked uploads - continuation steps (jobs)", () => {
  const T = Date.parse("2026-11-02T10:00:00.000Z");
  const HOUR = 3_600_000;
  const SESSION_URI = "https://upload.example/session?upload_id=capability-1";

  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };

  type RunOut = {
    status: string;
    results: Array<{ platform: Platform; status: string; error?: string }>;
  };

  /** The platforms' `publishVideo` behaviour, by call: anything unlisted succeeds. */
  function platformCalls(
    impls: Partial<Record<Platform, (call: number, ctx: PublishContext) => Promise<unknown> | unknown>>,
  ) {
    const calls: Partial<Record<Platform, number>> = {};
    getPlatformClientMock.mockImplementation((platform: Platform) => ({
      publishVideo: vi.fn(async (ctx: PublishContext) => {
        publishCtxs.push(ctx);
        const call = (calls[platform] = (calls[platform] ?? 0) + 1);
        const impl = impls[platform];
        return impl ? impl(call, ctx) : { externalPostId: `ext-${platform}` };
      }),
    }));
    return calls;
  }

  const CONTINUE_NOW = { continuation: { resumeAt: null } };

  /** An in-memory store with the real scoping: result, run, platform and kind. */
  function memoryUploadStates() {
    const saved = new Map<string, unknown>();
    uploadStateMocks.createStore.mockImplementation(
      (args: { resultId: string; runId: string; platform: string }) => {
        const keyOf = (kind: string) => `${args.resultId}|${args.runId}|${args.platform}|${kind}`;
        return {
          load: async (kind: string) => saved.get(keyOf(kind)) ?? null,
          save: async (kind: string, snapshot: unknown) => {
            // The real store refuses a URL in the readable data (uploadState.ts).
            if ((JSON.stringify((snapshot as { data: unknown }).data) ?? "").includes("://")) {
              throw Object.assign(new Error("The upload could not be tracked."), {
                code: "UPLOAD_STATE_PLAINTEXT_URL",
              });
            }
            saved.set(keyOf(kind), snapshot);
          },
          clear: async () => {
            for (const key of [...saved.keys()]) {
              if (key.startsWith(`${args.resultId}|${args.runId}|`)) saved.delete(key);
            }
          },
        };
      },
    );
    return saved;
  }

  function publishRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
  }

  function retryRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null, mimeType: "video/mp4" });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(retryPlatforms)({
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step,
    }) as Promise<RunOut>;
  }

  const failedWrites = () => resultWrites().filter((w) => w.status === "failed");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a step whose client reports a continuation", () => {
    it("releases the claim (one write that bumps the heartbeat), finalizes nothing, and reports `continue` with no sleep", async () => {
      const calls = platformCalls({
        x: (call) => (call === 1 ? CONTINUE_NOW : { externalPostId: "ext-x" }),
      });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      // The step's memoized output: platform, status, the instant it is due, no sleep.
      expect(step.outputs["publish-to-x"]).toEqual({
        platform: "x",
        status: "continue",
        resumeAt: new Date(T).toISOString(),
        sleep: false,
      });
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(1);
      expect(releaseContinuationSpy).toHaveBeenCalledWith("result-x", "run-1");
      // No rate-limit bookkeeping: the release is not a deferral.
      expect(releaseSpy).not.toHaveBeenCalled();
      // The first write is the release; the only other is the continuation's own success.
      expect(resultWrites()).toEqual([
        { claimRunId: null, claimedAt: null, ...HEARTBEAT },
        { status: "success", externalPostId: "ext-x", ...CLEARS_STATE, ...HEARTBEAT },
      ]);
      expect(db.resultUpdate.mock.calls[0][0]).toMatchObject({
        where: { id: "result-x", claimRunId: "run-1", status: "pending" },
      });
      expect(failedWrites()).toEqual([]);
      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(calls.x).toBe(2);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("runs publish-to-x-c1: it claims again and calls the client with continuation 1 and a store for the same result", async () => {
      platformCalls({ x: (call) => (call === 1 ? CONTINUE_NOW : { externalPostId: "ext-x" }) });
      const step = fakeStep();

      await publishRun(["x"], step);

      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-x",
        "run:publish-to-x-c1",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      // Two claims by the same run: the step, then its continuation.
      expect(claimWrites()).toEqual([
        { id: "result-x", claimRunId: "run-1" },
        { id: "result-x", claimRunId: "run-1" },
      ]);
      expect(publishCtxs.map((c) => c.continuation)).toEqual([0, 1]);
      // The store is always handed over, built for the SAME (result, run, platform) each step.
      expect(publishCtxs.every((c) => c.uploadState !== undefined)).toBe(true);
      expect(uploadStateMocks.createStore).toHaveBeenCalledTimes(2);
      expect(uploadStateMocks.createStore.mock.calls).toEqual([
        [{ resultId: "result-x", runId: "run-1", platform: "x" }],
        [{ resultId: "result-x", runId: "run-1", platform: "x" }],
      ]);
    });

    it("refreshes the job heartbeat before the continuation step claims, not before the first step", async () => {
      platformCalls({ x: (call) => (call === 1 ? CONTINUE_NOW : { externalPostId: "ext-x" }) });

      await publishRun(["x"]);

      expect(db.postJobUpdateMany).toHaveBeenCalledTimes(1);
      expect(db.postJobUpdateMany).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { updatedAt: expect.any(Date) },
      });
      const [firstClaim, secondClaim] = db.resultUpdateMany.mock.invocationCallOrder;
      const heartbeat = db.postJobUpdateMany.mock.invocationCallOrder[0];
      expect(heartbeat).toBeGreaterThan(firstClaim);
      expect(heartbeat).toBeLessThan(secondClaim);
    });

    it("sleeps first (publish-to-x-wait-c1) when the client asks to be called again later", async () => {
      platformCalls({
        x: (call) => (call === 1 ? { continuation: { resumeAt: T + 60_000 } } : { externalPostId: "ext-x" }),
      });
      const step = fakeStep();

      await publishRun(["x"], step);

      expect(step.outputs["publish-to-x"]).toEqual({
        platform: "x",
        status: "continue",
        resumeAt: new Date(T + 60_000).toISOString(),
        sleep: true,
      });
      expect(step.order.slice(1, 4)).toEqual([
        "run:publish-to-x",
        "sleepUntil:publish-to-x-wait-c1",
        "run:publish-to-x-c1",
      ]);
      expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-x-wait-c1", new Date(T + 60_000));
    });

    it("does not sleep for a wait too short to be worth a durable sleep, and never reports a time in the past", async () => {
      platformCalls({
        x: (call) => (call === 1 ? { continuation: { resumeAt: T - 5_000 } } : { externalPostId: "ext-x" }),
        linkedin: (call) => (call === 1 ? { continuation: { resumeAt: T + 500 } } : { externalPostId: "ext-linkedin" }),
      });
      const step = fakeStep();

      await publishRun(["x", "linkedin"], step);

      expect(step.outputs["publish-to-x"]).toMatchObject({ resumeAt: new Date(T).toISOString(), sleep: false });
      expect(step.outputs["publish-to-linkedin"]).toMatchObject({ sleep: false });
      expect(step.sleepUntil).not.toHaveBeenCalled();
    });

    it("caps the wait: a continuation is not a rate-limit deferral, so a long sleep would look like a dead run to the reconciler", async () => {
      platformCalls({
        x: (call) => (call === 1 ? { continuation: { resumeAt: T + 5 * HOUR } } : { externalPostId: "ext-x" }),
      });
      const step = fakeStep();

      await publishRun(["x"], step);

      expect(step.outputs["publish-to-x"]).toEqual({
        platform: "x",
        status: "continue",
        resumeAt: new Date(T + 15 * 60_000).toISOString(),
        sleep: true,
      });
    });

    it("is skipped, with no sleep, when the claim it held is gone by the time it is released", async () => {
      platformCalls({ x: () => ({ continuation: { resumeAt: T + 60_000 } }) });
      stubResultStore({ "result-x": {} });
      // Something else failed the result meanwhile (the reconciler, an onFailure handler).
      db.resultUpdate.mockRejectedValue(p2025());
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(releaseContinuationSpy).toHaveBeenCalledTimes(1);
      expect(step.sleepUntil).not.toHaveBeenCalled();
      expect(step.order).not.toContain("run:publish-to-x-c1");
      expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
    });

    it("works the same in the retry function, under retry-<platform> ids", async () => {
      platformCalls({
        x: (call) => (call === 1 ? { continuation: { resumeAt: T + 30_000 } } : { externalPostId: "ext-x" }),
      });
      const step = fakeStep();

      const out = await retryRun(["x"], step);

      expect(step.order.filter((entry) => /retry-x/.test(entry))).toEqual([
        "run:retry-x",
        "sleepUntil:retry-x-wait-c1",
        "run:retry-x-c1",
      ]);
      expect(publishCtxs.map((c) => c.continuation)).toEqual([0, 1]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it("interleaves platforms: x continues while youtube is still on its first step", async () => {
      platformCalls({
        x: (call) => (call === 1 ? CONTINUE_NOW : { externalPostId: "ext-x" }),
      });
      const step = fakeStep();

      const out = await publishRun(["x", "youtube"], step);

      expect(step.order.slice(1, 5)).toEqual([
        "run:publish-to-x",
        "run:publish-to-youtube",
        "run:publish-to-x-c1",
        "run:finalize-job",
      ]);
      expect(out.results).toEqual([
        { platform: "x", status: "success" },
        { platform: "youtube", status: "success" },
      ]);
    });
  });

  describe("the continuation cap (MAX_CONTINUATIONS_PER_RESULT = 40)", () => {
    it("finalizes failed UPLOAD_INCOMPLETE when the 41st continuation is asked for", async () => {
      const calls = platformCalls({ x: () => CONTINUE_NOW });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      // The first step plus -c1 ... -c40; the 41st continuation never starts.
      expect(calls.x).toBe(41);
      expect(step.order).toContain("run:publish-to-x-c40");
      expect(step.order).not.toContain("run:publish-to-x-c41");
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(40);
      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "UPLOAD_INCOMPLETE",
          errorMessage: "The upload didn't finish in time. Nothing was posted — please retry.",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
      expect(out.results).toEqual([
        {
          platform: "x",
          status: "failed",
          error: "The upload didn't finish in time. Nothing was posted — please retry.",
        },
      ]);
    });

    it("lets a result continue 40 times and still succeed", async () => {
      const calls = platformCalls({ x: (call) => (call <= 40 ? CONTINUE_NOW : { externalPostId: "ext-x" }) });

      const out = await publishRun(["x"]);

      expect(calls.x).toBe(41);
      expect(failedWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });
  });

  // 2026-11-02 scale audit (jobs B3): a post id means the commit call went through,
  // so the post is live. Continuing then would run the platform again and post twice.
  describe("a client result carrying both a continuation and a post id", () => {
    const both = { externalPostId: "ext-x", continuation: { resumeAt: null } };

    it("is finalized as success and never continued, with an error-level log", async () => {
      const calls = platformCalls({ x: () => both });
      const errorLog = vi.spyOn(logger, "error");
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(1);
      expect(releaseContinuationSpy).not.toHaveBeenCalled();
      expect(step.order).not.toContain("run:publish-to-x-c1");
      expect(resultWrites()).toEqual([
        { status: "success", externalPostId: "ext-x", ...CLEARS_STATE, ...HEARTBEAT },
      ]);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(/continuation.*post id|post id.*continuation/i),
        expect.objectContaining({ platform: "x", resultRecordId: "result-x", externalPostId: "ext-x" }),
      );
    });

    it("does the same in a continuation step", async () => {
      const calls = platformCalls({ x: (call) => (call === 1 ? CONTINUE_NOW : both) });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(2);
      expect(step.order).not.toContain("run:publish-to-x-c2");
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(1);
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an empty string", ""],
    ])("still continues when the post id is %s (nothing is live)", async (_label, externalPostId) => {
      const calls = platformCalls({
        x: (call) => (call === 1 ? { externalPostId, continuation: { resumeAt: null } } : { externalPostId: "ext-x" }),
      });
      const errorLog = vi.spyOn(logger, "error");

      const out = await publishRun(["x"]);

      expect(calls.x).toBe(2);
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
      expect(out.results).toEqual([{ platform: "x", status: "success" }]);
    });
  });

  // 2026-11-02 scale audit (jobs B3): an error message can carry a capability URL (a
  // fetch error quotes the URL it failed on). It is replaced before it reaches the
  // result row, the log or the step output.
  describe("an error message that holds a URL", () => {
    const leaky = (url: string) =>
      Object.assign(new Error(`PUT ${url} failed: socket hang up`), { code: "X_VIDEO_APPEND_FAILED" });

    it("is scrubbed from the result's errorMessage, the step output and the logs", async () => {
      platformCalls({
        x: () => {
          throw leaky(SESSION_URI);
        },
      });
      const step = fakeStep();

      const out = await publishRun(["x"], step);

      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "X_VIDEO_APPEND_FAILED",
          errorMessage: "PUT [url] failed: socket hang up",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
      expect(out.results).toEqual([
        { platform: "x", status: "failed", error: "PUT [url] failed: socket hang up" },
      ]);
      expect(JSON.stringify(step.outputs)).not.toContain("upload.example");
      const logged = JSON.stringify(
        [console.log, console.info, console.warn, console.error].map((fn) => vi.mocked(fn).mock.calls),
      );
      expect(logged).not.toContain("upload.example");
      expect(logged).not.toContain("capability-1");
      // The rest of the failure is still logged.
      expect(logged).toContain("X_VIDEO_APPEND_FAILED");
    });

    it("replaces every http and https URL, to the next space, and leaves other text alone", async () => {
      platformCalls({
        x: () => {
          throw Object.assign(
            new Error("a https://u.example/a?x=1 b HTTP://u.example/b c http://u.example/c; done"),
            { code: "X_VIDEO_APPEND_FAILED" },
          );
        },
      });

      await publishRun(["x"]);

      expect(failedWrites()[0]).toMatchObject({ errorMessage: "a [url] b [url] c [url] done" });
    });

    it("keeps a message without a URL exactly as it was", async () => {
      platformCalls({
        x: () => {
          throw Object.assign(new Error("Plain failure (status 400)"), { code: "X_TWEET_FAILED" });
        },
      });

      await publishRun(["x"]);

      expect(failedWrites()[0]).toMatchObject({ errorMessage: "Plain failure (status 400)" });
    });

    it("still falls back to the generic message for an error with no message", async () => {
      platformCalls({
        x: () => {
          throw Object.assign(new Error(""), { code: "X_TWEET_FAILED" });
        },
      });

      await publishRun(["x"]);

      expect(failedWrites()[0]).toMatchObject({ errorMessage: "Failed to publish to platform." });
    });
  });

  describe("the YouTube upload budget (one slot per upload session)", () => {
    const KIND = "youtube_resumable";

    it("is spent on publish-to-youtube, and not on its continuation or its rate-limit retry (the store holds the session)", async () => {
      memoryUploadStates();
      platformCalls({
        youtube: async (call, ctx) => {
          if (call === 1) {
            await ctx.uploadState!.save(KIND, { data: { confirmed: 5 }, secret: { sessionUri: SESSION_URI } });
            return CONTINUE_NOW;
          }
          if (call === 2) {
            expect(await ctx.uploadState!.load(KIND)).not.toBeNull();
            throw rateLimitedError("youtube", "rate_limited", T + HOUR);
          }
          return { externalPostId: "ext-youtube" };
        },
      });
      const step = fakeStep();

      const out = await publishRun(["youtube"], step);

      expect(step.order.slice(1, 5)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-youtube-c1",
        "sleepUntil:publish-to-youtube-wait-rl1",
        "run:publish-to-youtube-rl1",
      ]);
      // The continuation number of the three steps: first, -c1, and -rl1 behind it.
      expect(publishCtxs.map((c) => c.continuation)).toEqual([0, 1, 1]);
      expect(consumeSlotMock).toHaveBeenCalledTimes(1);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
    });

    it("is spent again when the store holds no session for this run (state lost, or saved by another run)", async () => {
      memoryUploadStates();
      platformCalls({ youtube: (call) => (call === 1 ? CONTINUE_NOW : { externalPostId: "ext-youtube" }) });

      await publishRun(["youtube"]);

      // The client saved nothing, so the continuation starts a new session: a new slot.
      expect(consumeSlotMock).toHaveBeenCalledTimes(2);
    });

    // A YouTube session restart leaves a tombstone: readable data with the restart count and no
    // sealed secret (youtubeClient.ts). What decides the slot is whether a sealed session is saved.
    it("is spent once for the new session behind a tombstone (state with no sealed secret), and never for a live session", async () => {
      const saved = memoryUploadStates();
      platformCalls({
        youtube: async (call, ctx) => {
          if (call === 1) {
            await ctx.uploadState!.save(KIND, { data: { confirmed: 5 }, secret: { sessionUri: SESSION_URI } });
            return CONTINUE_NOW;
          }
          if (call === 2) {
            // The session is gone: the tombstone replaces it.
            await ctx.uploadState!.save(KIND, { data: { sessionRestarts: 1 } });
            return CONTINUE_NOW;
          }
          if (call === 3) {
            // The step after the tombstone starts the new session.
            await ctx.uploadState!.save(KIND, { data: { confirmed: 0, sessionRestarts: 1 }, secret: { sessionUri: SESSION_URI } });
            return CONTINUE_NOW;
          }
          return { externalPostId: "ext-youtube" };
        },
      });

      const out = await publishRun(["youtube"]);

      // The first step (no state) and the step after the tombstone: two sessions, two slots.
      expect(consumeSlotMock).toHaveBeenCalledTimes(2);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
      for (const snapshot of saved.values()) {
        expect(JSON.stringify((snapshot as { data: unknown }).data)).not.toContain("://");
      }
    });

    it("does not look at the store, or spend a slot, for another platform", async () => {
      memoryUploadStates();
      platformCalls({});

      await publishRun(["x"]);

      expect(consumeSlotMock).not.toHaveBeenCalled();
    });
  });

  describe("claims across continuation steps", () => {
    it("a continuation step that finds its OWN claim records PUBLISH_UNCONFIRMED and never calls the platform again", async () => {
      stubResultStore({ "result-x": {} });
      const calls = platformCalls({
        x: (call) => {
          // The release of -c1 fails with a database blip: the step dies holding its
          // claim, and Inngest retries it.
          if (call === 2) db.resultUpdate.mockRejectedValueOnce(new Error("connection reset"));
          return CONTINUE_NOW;
        },
      });
      const step = fakeStep();
      const innerRun = step.run.getMockImplementation()!;
      step.run.mockImplementation(async (id: string, cb: () => unknown) => {
        try {
          return await innerRun(id, cb);
        } catch (error) {
          if (id !== "publish-to-x-c1") throw error;
          return innerRun(id, cb); // Inngest's step retry
        }
      });

      const out = await publishRun(["x"], step);

      expect(calls.x).toBe(2);
      expect(failedWrites()).toEqual([
        {
          status: "failed",
          errorCode: "PUBLISH_UNCONFIRMED",
          errorMessage:
            "We couldn't confirm this post. It may already be live — check the platform before you retry.",
          ...CLEARS_STATE,
          ...HEARTBEAT,
        },
      ]);
      expect(out.results).toEqual([{ platform: "x", status: "failed", error: "Publish unconfirmed" }]);
    });

    it("a duplicate run that took the claim between two steps makes the continuation skip without calling the platform", async () => {
      const rows = stubResultStore({ "result-x": {} });
      const calls = platformCalls({
        x: () => {
          // A duplicate run claims the result as soon as this step releases it.
          db.resultUpdate.mockImplementationOnce(async () => {
            Object.assign(rows.get("result-x")!, { claimRunId: "run-other" });
            return {};
          });
          return CONTINUE_NOW;
        },
      });

      const out = await publishRun(["x"]);

      expect(calls.x).toBe(1);
      expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
    });
  });

  describe("capability URLs", () => {
    it("never reach a step output or a log line, across a continuation and a rate-limit deferral", async () => {
      memoryUploadStates();
      platformCalls({
        youtube: async (call, ctx) => {
          await ctx.uploadState!.save("youtube_resumable", {
            data: { confirmed: call },
            secret: { sessionUri: SESSION_URI },
          });
          if (call === 1) return { continuation: { resumeAt: T + 60_000 } };
          if (call === 2) throw rateLimitedError("youtube", "rate_limited", T + HOUR);
          return { externalPostId: "ext-youtube" };
        },
      });
      const step = fakeStep();

      await publishRun(["youtube"], step);

      expect(Object.keys(step.outputs)).toEqual(
        expect.arrayContaining(["publish-to-youtube", "publish-to-youtube-c1", "publish-to-youtube-rl1"]),
      );
      const outputs = JSON.stringify(step.outputs);
      expect(outputs).not.toContain("https://");
      expect(outputs).not.toContain("capability");
      const logged = JSON.stringify(
        [console.log, console.info, console.warn, console.error].map((fn) => vi.mocked(fn).mock.calls),
      );
      expect(logged).not.toContain(SESSION_URI);
    });
  });

  // 2026-11-02 scale audit (jobs L5): the REAL Instagram client, driven by a faked
  // Graph API, polls its REELS container once a minute across steps: one step
  // creates it, then one step per status check, each after a durable sleep. Only
  // the step that sees FINISHED calls media_publish.
  describe("Instagram container polling across steps (jobs L5)", () => {
    const PAGE_TOKEN = "page-token-for-instagram-e2e";
    const containerOk = (n: number) => new Response(JSON.stringify({ id: `container-${n}` }), { status: 200 });
    const dailyCap = () =>
      new Response(
        JSON.stringify({ error: { message: "m", type: "OAuthException", code: 9, error_subcode: 2207042 } }),
        { status: 400 },
      );
    const statusOf = (code: string) => new Response(JSON.stringify({ status_code: code }), { status: 200 });
    const throttled = () =>
      new Response(JSON.stringify({ error: { message: "m", type: "OAuthException", code: 80002 } }), { status: 400 });

    /**
     * The Graph API: containers are numbered in creation order; the status answers are
     * given in order, the last one repeating; media_publish succeeds unless `publishes` says otherwise.
     */
    function stubGraph(statuses: Array<() => Response>, publishes: Array<() => Response> = []) {
      let checks = 0;
      const calls = { container: 0, status: 0, publish: 0 };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/media_publish")) {
            calls.publish += 1;
            return publishes[calls.publish - 1]?.() ?? new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
          }
          if (url.includes("/ig-account-1/media")) {
            calls.container += 1;
            return containerOk(calls.container);
          }
          if (url.includes("fields=status_code")) {
            calls.status += 1;
            return statuses[Math.min(checks++, statuses.length - 1)]();
          }
          throw new Error(`Unexpected fetch in test: ${url}`);
        }),
      );
      return calls;
    }

    function instagramRun(step = fakeStep()) {
      db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
      db.mediaItemFindUnique.mockResolvedValue({
        id: "media-1",
        baseCaption: "c",
        deletedAt: null,
        mimeType: "video/mp4",
        storageLocation: "https://blob.example.com/m.mp4",
      });
      db.connectionFindMany.mockResolvedValue([{ id: "conn-instagram", platform: "instagram" }]);
      db.connectionFindUnique.mockResolvedValue({
        ...connectionRow("instagram"),
        accessToken: PAGE_TOKEN,
        accountIdentifier: "ig-account-1",
      });
      stubResults(["instagram"]);
      return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
    }

    beforeEach(() => {
      memoryUploadStates();
      getPlatformClientMock.mockImplementation(() => instagramClient);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("IN_PROGRESS, IN_PROGRESS, FINISHED: create, wait, check, wait, check, wait, check and publish", async () => {
      const graph = stubGraph([() => statusOf("IN_PROGRESS"), () => statusOf("IN_PROGRESS"), () => statusOf("FINISHED")]);
      const step = fakeStep();

      const out = await instagramRun(step);

      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-instagram",
        "sleepUntil:publish-to-instagram-wait-c1",
        "run:publish-to-instagram-c1",
        "sleepUntil:publish-to-instagram-wait-c2",
        "run:publish-to-instagram-c2",
        "sleepUntil:publish-to-instagram-wait-c3",
        "run:publish-to-instagram-c3",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      // Each of the first three steps hands its claim back and is due a minute later.
      for (const id of ["publish-to-instagram", "publish-to-instagram-c1", "publish-to-instagram-c2"]) {
        expect(step.outputs[id]).toEqual({
          platform: "instagram",
          status: "continue",
          resumeAt: new Date(T + 60_000).toISOString(),
          sleep: true,
        });
      }
      expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-instagram-wait-c1", new Date(T + 60_000));
      expect(claimWrites()).toHaveLength(4);
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(3);
      expect(releaseSpy).not.toHaveBeenCalled();
      // One container, three status checks, one media_publish.
      expect(graph).toEqual({ container: 1, status: 3, publish: 1 });
      expect(resultWrites().at(-1)).toEqual({
        status: "success",
        externalPostId: "media-1",
        ...CLEARS_STATE,
        ...HEARTBEAT,
      });
      expect(failedWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "instagram", status: "success" }]);
    });

    it("refreshes the job heartbeat at every wake, so the reconciler sees a live run", async () => {
      stubGraph([() => statusOf("IN_PROGRESS"), () => statusOf("FINISHED")]);

      await instagramRun();

      // -c1 and -c2 each refresh it before claiming; the first step does not.
      expect(db.postJobUpdateMany).toHaveBeenCalledTimes(2);
    });

    it("keeps the access token out of every step output and the saved state", async () => {
      const saved = memoryUploadStates();
      stubGraph([() => statusOf("IN_PROGRESS"), () => statusOf("FINISHED")]);
      const step = fakeStep();

      await instagramRun(step);

      expect(saved.size).toBe(1);
      expect(JSON.stringify(step.outputs)).not.toContain(PAGE_TOKEN);
      expect(JSON.stringify([...saved.values()])).not.toContain(PAGE_TOKEN);
    });

    it("a container stuck IN_PROGRESS fails INSTAGRAM_VIDEO_TIMEOUT on the 5th check (-c5), with no media_publish", async () => {
      const graph = stubGraph([() => statusOf("IN_PROGRESS")]);
      const step = fakeStep();

      const out = await instagramRun(step);

      expect(step.order).toContain("run:publish-to-instagram-c5");
      expect(step.order).not.toContain("run:publish-to-instagram-c6");
      expect(graph).toEqual({ container: 1, status: 5, publish: 0 });
      expect(failedWrites()).toEqual([
        expect.objectContaining({ status: "failed", errorCode: "INSTAGRAM_VIDEO_TIMEOUT", ...CLEARS_STATE }),
      ]);
      expect(out.results).toEqual([
        { platform: "instagram", status: "failed", error: "Instagram video processing timeout" },
      ]);
    });

    it("a throttled status check defers on the -rl ids, keeps the state, and the next attempt checks again", async () => {
      const graph = stubGraph([() => statusOf("IN_PROGRESS"), throttled, () => statusOf("FINISHED")]);
      const step = fakeStep();

      const out = await instagramRun(step);

      expect(step.order.slice(1, 7)).toEqual([
        "run:publish-to-instagram",
        "sleepUntil:publish-to-instagram-wait-c1",
        "run:publish-to-instagram-c1",
        "sleepUntil:publish-to-instagram-wait-c2",
        "run:publish-to-instagram-c2",
        "sleepUntil:publish-to-instagram-wait-rl1",
      ]);
      expect(step.order.slice(7, 9)).toEqual(["run:publish-to-instagram-rl1", "run:finalize-job"]);
      expect(step.outputs["publish-to-instagram-c2"]).toMatchObject({ platform: "instagram", status: "deferred" });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      // The container is never replaced, and the throttled query is the third request.
      expect(graph).toEqual({ container: 1, status: 3, publish: 1 });
      expect(out.results).toEqual([{ platform: "instagram", status: "success" }]);
    });

    // The 100-posts-a-day cap defers the result by 24 h, past Meta's 24 h container life.
    // The refusal is definitive (nothing was posted), so the saved container is dropped and
    // the deferred attempt creates a new one.
    it("after the daily cap, the deferred attempt (-rl1) creates a NEW container, waits for it, and publishes it", async () => {
      const saved = memoryUploadStates();
      const graph = stubGraph([() => statusOf("FINISHED")], [dailyCap]);
      const step = fakeStep();

      const out = await instagramRun(step);

      expect(step.order).toEqual([
        "run:fetch-data",
        "run:publish-to-instagram",
        "sleepUntil:publish-to-instagram-wait-c1",
        "run:publish-to-instagram-c1",
        "sleepUntil:publish-to-instagram-wait-rl1",
        "run:publish-to-instagram-rl1",
        "sleepUntil:publish-to-instagram-wait-c2",
        "run:publish-to-instagram-c2",
        "run:finalize-job",
        "sendEvent:notify-outcome",
      ]);
      expect(step.outputs["publish-to-instagram-c1"]).toMatchObject({ platform: "instagram", status: "deferred" });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(2);
      // Two containers, one status check each, two media_publish calls (the first refused).
      expect(graph).toEqual({ container: 2, status: 2, publish: 2 });
      const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
      const published = urls.filter((u) => u.includes("/media_publish"));
      expect(new URL(published[0]).searchParams.get("creation_id")).toBe("container-1");
      expect(new URL(published[1]).searchParams.get("creation_id")).toBe("container-2");
      expect(saved.size).toBe(1);
      expect(JSON.stringify([...saved.values()])).toContain("container-2");
      expect(JSON.stringify([...saved.values()])).not.toContain("container-1");
      expect(failedWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "instagram", status: "success" }]);
    });

    it("runs the other platforms while Instagram waits for its first check", async () => {
      stubGraph([() => statusOf("FINISHED")]);
      const step = fakeStep();
      db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
      db.mediaItemFindUnique.mockResolvedValue({
        id: "media-1",
        baseCaption: "c",
        deletedAt: null,
        mimeType: "video/mp4",
        storageLocation: "https://blob.example.com/m.mp4",
      });
      db.connectionFindMany.mockResolvedValue([
        { id: "conn-instagram", platform: "instagram" },
        { id: "conn-linkedin", platform: "linkedin" },
      ]);
      db.connectionFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          ...connectionRow(where.id.replace("conn-", "") as Platform),
          accountIdentifier: "ig-account-1",
        }),
      );
      stubResults(["instagram", "linkedin"]);
      getPlatformClientMock.mockImplementation((platform: Platform) =>
        platform === "instagram"
          ? instagramClient
          : { publishVideo: vi.fn(async () => ({ externalPostId: "ext-linkedin" })) },
      );

      const out = (await handlerOf(publishToAllPlatforms)({ event: publishEvent, step })) as RunOut;

      expect(step.order.slice(1, 6)).toEqual([
        "run:publish-to-instagram",
        "run:publish-to-linkedin",
        "sleepUntil:publish-to-instagram-wait-c1",
        "run:publish-to-instagram-c1",
        "run:finalize-job",
      ]);
      expect(out.results).toEqual([
        { platform: "instagram", status: "success" },
        { platform: "linkedin", status: "success" },
      ]);
    });
  });

  // 2026-11-02 scale audit (jobs B3): the REAL YouTube client, driven by a faked Google
  // API, uploads a 300 MiB video across steps. Each 16 MiB chunk "takes" 50 s of the
  // fake clock, so four fit in a 225 s step (a fifth would start with 25 s left).
  describe("YouTube resumable upload across steps (jobs B3)", () => {
    const MIB = 1024 * 1024;
    const TOTAL = 300 * MIB; // 18 chunks of 16 MiB and a last one of 12 MiB
    const SESSION_SECRET = "E2E-SESSION-SECRET";
    const CHUNK_MS = 50_000;

    /**
     * Google's side: a session that remembers how many bytes it holds, a blob that serves
     * ranges of a 300 MiB video lazily, and the numbering of chunk requests (1-based, across
     * sessions). `chunkAnswer` replaces the answer to one chunk; `afterChunk` runs after it.
     */
    function stubGoogle(
      hooks: { chunkAnswer?: (n: number) => Response | undefined; afterChunk?: (n: number) => void } = {},
    ) {
      let session = 0;
      let received = 0;
      const expired = new Set<number>();
      const calls = { starts: 0, statuses: 0, chunks: 0, blobGets: 0, largestChunk: 0 };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          if (url.includes("blob.example.com")) {
            calls.blobGets += 1;
            const start = Number(/^bytes=(\d+)-$/.exec(headers.Range ?? "")?.[1] ?? 0);
            let produced = 0;
            const body = new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  const size = Math.min(1_000_000, TOTAL - start - produced);
                  if (size <= 0) return controller.close();
                  controller.enqueue(new Uint8Array(size).fill(7));
                  produced += size;
                },
              },
              { highWaterMark: 0 },
            );
            return new Response(body, {
              status: 206,
              headers: { "Content-Range": `bytes ${start}-${TOTAL - 1}/${TOTAL}` },
            });
          }
          if (url.includes("uploadType=resumable&part=")) {
            calls.starts += 1;
            session += 1;
            received = 0;
            return new Response(null, {
              status: 200,
              headers: {
                Location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${SESSION_SECRET}-${session}`,
              },
            });
          }
          const id = Number(new RegExp(`${SESSION_SECRET}-(\\d+)`).exec(url)?.[1]);
          if (!id) throw new Error(`Unexpected fetch in test: ${url}`);
          if (expired.has(id)) return new Response(null, { status: 404 });

          const incomplete = () =>
            new Response(null, { status: 308, headers: received > 0 ? { Range: `bytes=0-${received - 1}` } : {} });
          if (init?.body == null) {
            calls.statuses += 1;
            return received >= TOTAL
              ? new Response(JSON.stringify({ id: "yt-300" }), { status: 201 })
              : incomplete();
          }
          calls.chunks += 1;
          const n = calls.chunks;
          vi.setSystemTime(Date.now() + CHUNK_MS);
          calls.largestChunk = Math.max(calls.largestChunk, (init.body as Buffer).length);
          const forced = hooks.chunkAnswer?.(n);
          if (forced) return forced;
          const last = Number(/^bytes \d+-(\d+)\//.exec(headers["Content-Range"] ?? "")?.[1]);
          received = Math.max(received, last + 1);
          const answer =
            received >= TOTAL ? new Response(JSON.stringify({ id: "yt-300" }), { status: 201 }) : incomplete();
          hooks.afterChunk?.(n);
          return answer;
        }),
      );
      return { calls, expireSession: () => expired.add(session) };
    }

    function youtubeRun(step = fakeStep()) {
      db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
      db.mediaItemFindUnique.mockResolvedValue({
        id: "media-1",
        baseCaption: "c",
        deletedAt: null,
        mimeType: "video/mp4",
        storageLocation: "https://blob.example.com/m.mp4",
        originalFilename: "m.mp4",
        sizeBytes: TOTAL,
        metadata: null,
      });
      db.connectionFindMany.mockResolvedValue([{ id: "conn-youtube", platform: "youtube" }]);
      stubResults(["youtube"]);
      return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
    }

    const orderOf = (step: FakeStep) => step.order.filter((entry) => /publish-to-youtube/.test(entry));

    beforeEach(() => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "youtube");
      getPlatformClientMock.mockImplementation(() => youtubeClient);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("uploads 300 MiB in five steps for ONE slot: the session is started once, every later step asks it first, the last one posts", async () => {
      const saved = memoryUploadStates();
      const google = stubGoogle();
      const step = fakeStep();

      const out = await youtubeRun(step);

      expect(orderOf(step)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-youtube-c1",
        "run:publish-to-youtube-c2",
        "run:publish-to-youtube-c3",
        "run:publish-to-youtube-c4",
      ]);
      expect(step.sleepUntil).not.toHaveBeenCalled();
      // 19 chunks (18 x 16 MiB + 12 MiB), none over 16 MiB; one session; a status query at the start of each later step.
      expect(google.calls).toMatchObject({ starts: 1, chunks: 19, statuses: 4, blobGets: 5 });
      expect(google.calls.largestChunk).toBe(16 * MIB);
      expect(consumeSlotMock).toHaveBeenCalledTimes(1);
      expect(claimWrites()).toHaveLength(5);
      expect(releaseContinuationSpy).toHaveBeenCalledTimes(4);
      expect(resultWrites().at(-1)).toEqual({
        status: "success",
        externalPostId: "yt-300",
        ...CLEARS_STATE,
        ...HEARTBEAT,
      });
      expect(failedWrites()).toEqual([]);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);

      // Only the sealed secret holds the session URI: not the readable data, a step output or a log line.
      for (const snapshot of saved.values()) {
        expect(JSON.stringify((snapshot as { data: unknown }).data)).not.toContain("://");
      }
      expect(JSON.stringify(step.outputs)).not.toContain(SESSION_SECRET);
      const logged = JSON.stringify(
        [console.log, console.info, console.warn, console.error].map((fn) => vi.mocked(fn).mock.calls),
      );
      expect(logged).not.toContain(SESSION_SECRET);
    });

    it("an expired session spends a second slot in the step that starts the new session, not in the one that finds it gone", async () => {
      memoryUploadStates();
      const google = stubGoogle({ afterChunk: (n) => (n === 4 ? google.expireSession() : undefined) });
      const step = fakeStep();

      const out = await youtubeRun(step);

      // Step 0 ends with the session expiring. -c1 learns that (404), drops the state and
      // continues without starting anything; -c2 starts the new session and spends its slot.
      expect(orderOf(step).slice(0, 4)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-youtube-c1",
        "run:publish-to-youtube-c2",
        "run:publish-to-youtube-c3",
      ]);
      expect(google.calls.starts).toBe(2);
      expect(consumeSlotMock).toHaveBeenCalledTimes(2);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
      expect(resultWrites().at(-1)).toMatchObject({ status: "success", externalPostId: "yt-300" });
    });

    it("a session lost three times fails YOUTUBE_UPLOAD_FAILED after two restarts: three sessions, three slots, nothing posted", async () => {
      const saved = memoryUploadStates();
      // Each session takes four chunks (one step), then is gone when the next step asks it.
      const google = stubGoogle({ afterChunk: (n) => (n % 4 === 0 ? google.expireSession() : undefined) });
      const step = fakeStep();

      const out = await youtubeRun(step);

      // Start, 404 (tombstone 1), start, 404 (tombstone 2), start, 404: past the cap.
      expect(orderOf(step)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-youtube-c1",
        "run:publish-to-youtube-c2",
        "run:publish-to-youtube-c3",
        "run:publish-to-youtube-c4",
        "run:publish-to-youtube-c5",
      ]);
      expect(google.calls.starts).toBe(3);
      expect(consumeSlotMock).toHaveBeenCalledTimes(3);
      expect(failedWrites()).toHaveLength(1);
      expect(failedWrites()[0]).toMatchObject({ errorCode: "YOUTUBE_UPLOAD_FAILED" });
      expect(out.results).toEqual([expect.objectContaining({ platform: "youtube", status: "failed" })]);
      // No tombstone or progress save put the session URI in the readable data.
      for (const snapshot of saved.values()) {
        expect(JSON.stringify((snapshot as { data: unknown }).data)).not.toContain("://");
      }
      expect(JSON.stringify(step.outputs)).not.toContain(SESSION_SECRET);
    });

    it("a rate limit on a chunk waits on the -rl ids and resumes the SAME session: no second slot, no second start", async () => {
      memoryUploadStates();
      const google = stubGoogle({
        chunkAnswer: (n) => (n === 6 ? new Response("", { status: 429, headers: { "Retry-After": "120" } }) : undefined),
      });
      const step = fakeStep();

      const out = await youtubeRun(step);

      expect(orderOf(step).slice(0, 4)).toEqual([
        "run:publish-to-youtube",
        "run:publish-to-youtube-c1",
        "sleepUntil:publish-to-youtube-wait-rl1",
        "run:publish-to-youtube-rl1",
      ]);
      expect(step.outputs["publish-to-youtube-c1"]).toMatchObject({ platform: "youtube", status: "deferred" });
      expect(google.calls.starts).toBe(1);
      expect(consumeSlotMock).toHaveBeenCalledTimes(1);
      expect(out.results).toEqual([{ platform: "youtube", status: "success" }]);
      expect(resultWrites().at(-1)).toMatchObject({ status: "success", externalPostId: "yt-300" });
    });
  });
});

// Review Focus 2, the sweep side. The 6 h stale sweep fails dispatched jobs whose
// heartbeat is older than 6 h; a job whose YouTube result sleeps ~20 h has such a
// heartbeat and must be left alone.
describe("stalePostJobSweep - deferral exclusion and singleton", () => {
  const NOW = Date.parse("2026-11-02T10:30:00.000Z");
  const optsOf = () => (stalePostJobSweep as unknown as { opts: Record<string, unknown> }).opts;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db.postJobUpdateMany.mockResolvedValue({ count: 0 });
    healResultWorkspaceIdsMock.mockReset();
    healResultWorkspaceIdsMock.mockResolvedValue({ healed: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fail a job that has a pending result deferred to a platform limit", async () => {
    await handlerOf(stalePostJobSweep)({ event: { name: "inngest/scheduled.timer", data: {} }, step: fakeStep() });

    const cutoff = new Date(NOW - STALE_AFTER_MS);
    expect(db.postJobUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.postJobUpdateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["pending", "in_progress"] },
        updatedAt: { lt: cutoff },
        // Review Focus 2: a deferral still in the future, or ended less than 6 h ago.
        results: { none: { status: "pending", deferredUntil: { gte: cutoff } } },
      },
      data: { status: "failed" },
    });
  });

  it("runs one sweep at a time (singleton skip)", () => {
    expect(optsOf().id).toBe("stale-post-job-sweep");
    expect(optsOf().singleton).toEqual({ mode: "skip" });
  });
});

// 2026-11-01 scale audit (db M5): rows the previous deployment writes while the
// workspaceId migrations run carry a NULL workspaceId; the hourly sweep heals
// them, in its own step, so a heal failure can never fail the stale-job sweep.
describe("stalePostJobSweep - result workspace heal step", () => {
  const NOW = Date.parse("2026-11-02T10:30:00.000Z");
  const run = (step = fakeStep()) =>
    handlerOf(stalePostJobSweep)({ event: { name: "inngest/scheduled.timer", data: {} }, step });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db.postJobUpdateMany.mockResolvedValue({ count: 0 });
    healResultWorkspaceIdsMock.mockReset();
    healResultWorkspaceIdsMock.mockResolvedValue({ healed: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs fail-stale-post-jobs, then heal-result-workspace", async () => {
    const step = fakeStep();
    await run(step);

    expect(step.order).toEqual(["run:fail-stale-post-jobs", "run:heal-result-workspace"]);
    expect(healResultWorkspaceIdsMock).toHaveBeenCalledTimes(1);
  });

  it("returns the heal count as the step output", async () => {
    healResultWorkspaceIdsMock.mockResolvedValue({ healed: 12 });
    const step = fakeStep();
    await run(step);

    expect(step.outputs["heal-result-workspace"]).toEqual({ healed: 12 });
  });

  it("logs a heal error and still completes the sweep", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      healResultWorkspaceIdsMock.mockRejectedValue(new Error("db down"));
      db.postJobUpdateMany.mockResolvedValue({ count: 2 });
      const step = fakeStep();

      await expect(run(step)).resolves.toMatchObject({ swept: 2 });

      expect(step.order).toEqual(["run:fail-stale-post-jobs", "run:heal-result-workspace"]);
      expect(step.outputs["heal-result-workspace"]).toEqual({ healed: 0 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain("[StaleSweep]");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not reach the heal when the stale-job step itself fails", async () => {
    db.postJobUpdateMany.mockRejectedValue(new Error("db down"));
    const step = fakeStep();

    await expect(run(step)).rejects.toThrow("db down");

    expect(healResultWorkspaceIdsMock).not.toHaveBeenCalled();
  });
});

// Fix round 1 (Important 1): `notify-outcome` used to be sent after every
// finalize. With a deferral that is wrong: a retry run that finalizes while
// another platform's result is still asleep would email "YouTube: Pending", and
// the original run would email again ~20 h later. The event is now sent only when
// the memoized finalize result is a terminal outcome (`completed` / `failed`),
// which is deterministic across replays; the step id `notify-outcome` is unchanged.
describe("outcome email - only for a terminal job status (fix round 1, Important 1)", () => {
  const T = Date.parse("2026-11-02T10:00:00.000Z");
  const HOUR = 3_600_000;

  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };

  /** The `postJob` row both functions read (a superset: publish needs less than retry). */
  function seedJob() {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1", workspaceId: WORKSPACE.id, mediaItemId: "media-1",
      baseCaption: "c", perPlatformOverrides: null, publishMetadata: null,
    });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null, mimeType: "video/mp4" });
  }

  /** Result lookups served from the in-memory table: ids by platform, statuses for the recompute. */
  function serveResultsFrom(rows: Map<string, { status: string }>) {
    db.resultFindMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Promise.resolve(
        [...rows.entries()].map(([id, row]) =>
          select.platform ? { id, platform: id.replace("result-", "") } : { status: row.status },
        ),
      ),
    );
  }

  type RunOut = { status: string; results: Array<{ platform: Platform; status: string }> };

  function publish(platforms: Platform[], step: FakeStep, runId = "run-1") {
    seedJob();
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    return handlerOf(publishToAllPlatforms)({ runId, event: publishEvent, step }) as Promise<RunOut>;
  }

  function retry(platforms: Platform[], step: FakeStep, runId = "run-1") {
    seedJob();
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    return handlerOf(retryPlatforms)({
      runId,
      event: { name: "post/retry.requested", data: { postJobId: "job-1", userId: "user-1", platforms } },
      step,
    }) as Promise<RunOut>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each([
    ["publishToAllPlatforms", publish, "finalize-job"],
    ["retryPlatforms", retry, "finalize-retry"],
  ] as const)("%s", (_name, run, finalizeId) => {
    it.each([
      ["completed", false],
      ["failed", true],
    ] as const)("sends the email, once, after %s", async (finalStatus, platformFails) => {
      const rows = stubResultStore({ "result-x": {} });
      serveResultsFrom(rows);
      if (platformFails) {
        getPlatformClientMock.mockImplementation(() => ({
          publishVideo: vi.fn(async () => {
            throw Object.assign(new Error("nope"), { code: "X_TWEET_FAILED", status: 403 });
          }),
        }));
      }
      const step = fakeStep();

      await run(["x"], step);

      expect(step.outputs[finalizeId]).toMatchObject({ finalStatus });
      expect(step.sendEvent).toHaveBeenCalledTimes(1);
      expect(step.sendEvent).toHaveBeenCalledWith("notify-outcome", {
        id: "notify-job-1-run-1",
        name: "notification.requested",
        data: { userId: "user-1", postJobId: "job-1" },
      });
      expect(step.order.slice(-2)).toEqual([`run:${finalizeId}`, "sendEvent:notify-outcome"]);
    });

    it("sends NO event when the job is still in_progress (another result is pending)", async () => {
      // x succeeds in this run; youtube is another run's result: still pending,
      // and claimed by that run (a publish run claims every pending result it can
      // reach, so one nobody holds would be taken and settled here).
      const rows = stubResultStore({
        "result-x": {},
        "result-youtube": { status: "pending", claimRunId: "run-other" },
      });
      serveResultsFrom(rows);
      const step = fakeStep();

      const out = await run(["x"], step);

      expect(rows.get("result-x")).toMatchObject({ status: "success" });
      expect(step.outputs[finalizeId]).toMatchObject({ finalStatus: "in_progress", successCount: 1 });
      expect(out.status).toBe("in_progress");
      expect(step.sendEvent).not.toHaveBeenCalled();
      expect(step.order.some((entry) => entry.startsWith("sendEvent:"))).toBe(false);
      // The finalize itself still ran (the job's status is recorded).
      expect(step.order).toContain(`run:${finalizeId}`);
    });
  });

  // The review's flow, end to end: X fails and YouTube defers 20 h; the user retries
  // X while YouTube sleeps; 20 h later YouTube publishes.
  it("X fails, YouTube defers, the user retries X: the retry run is silent and the original run sends the one email", async () => {
    const rows = stubResultStore({ "result-x": {}, "result-youtube": {} });
    serveResultsFrom(rows);
    consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt: new Date(T + 20 * HOUR) });
    const calls: Record<string, number> = {};
    getPlatformClientMock.mockImplementation((platform: Platform) => ({
      publishVideo: vi.fn(async (ctx: PublishContext) => {
        publishCtxs.push(ctx);
        calls[platform] = (calls[platform] ?? 0) + 1;
        if (platform === "x" && calls.x === 1) {
          throw Object.assign(new Error("nope"), { code: "X_TWEET_FAILED", status: 403 });
        }
        return { externalPostId: `ext-${platform}` };
      }),
    }));
    const original = fakeStep();
    const retryStep = fakeStep();
    const retried: { out?: RunOut } = {};
    original.sleepUntil.mockImplementation(async (id: string) => {
      original.order.push(`sleepUntil:${id}`);
      // While YouTube sleeps: the retry route re-queues the failed X, and its run goes.
      Object.assign(rows.get("result-x")!, { status: "pending", claimRunId: null, errorCode: null });
      retried.out = await retry(["x"], retryStep, "run-2");
    });

    const originalOut = await publish(["x", "youtube"], original);

    // The retry run finalized with YouTube still pending: in_progress, and silent.
    expect(retried.out?.results).toEqual([{ platform: "x", status: "success" }]);
    expect(retryStep.outputs["finalize-retry"]).toMatchObject({ finalStatus: "in_progress" });
    expect(retryStep.sendEvent).not.toHaveBeenCalled();
    // The original run settles YouTube, finalizes `completed`, and emails once, last.
    expect(original.order).toEqual([
      "run:fetch-data",
      "run:publish-to-x",
      "run:publish-to-youtube",
      "sleepUntil:publish-to-youtube-wait-rl1",
      "run:publish-to-youtube-rl1",
      "run:finalize-job",
      "sendEvent:notify-outcome",
    ]);
    expect(original.outputs["finalize-job"]).toMatchObject({ finalStatus: "completed", successCount: 2 });
    expect(original.sendEvent).toHaveBeenCalledTimes(1);
    expect(original.sendEvent).toHaveBeenCalledWith(
      "notify-outcome",
      expect.objectContaining({ id: "notify-job-1-run-1" }),
    );
    expect(originalOut.status).toBe("completed");
  });

  it("the original run on its own: YouTube defers then succeeds - still one email, after the final finalize", async () => {
    const rows = stubResultStore({ "result-x": {}, "result-youtube": {} });
    serveResultsFrom(rows);
    consumeSlotMock.mockResolvedValueOnce({ allowed: false, resetAt: new Date(T + 20 * HOUR) });
    getPlatformClientMock.mockImplementation((platform: Platform) => ({
      publishVideo: vi.fn(async () => ({ externalPostId: `ext-${platform}` })),
    }));
    const step = fakeStep();

    await publish(["x", "youtube"], step);

    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(step.order.filter((entry) => entry.startsWith("run:finalize"))).toEqual(["run:finalize-job"]);
    expect(step.order.slice(-2)).toEqual(["run:finalize-job", "sendEvent:notify-outcome"]);
    expect(step.order.indexOf("run:publish-to-youtube-rl1")).toBeLessThan(
      step.order.indexOf("run:finalize-job"),
    );
    expect(step.outputs["finalize-job"]).toMatchObject({ finalStatus: "completed" });
  });
});

// 2026-11-01 scale audit (jobs, notifications): the outcome mailer is throttled
// under Resend's 10 req/s team limit (V18) and retries a 429 / 5xx instead of
// dropping the email (V5, V8).
describe("sendNotification - throttle, retries and idempotent delivery", () => {
  const optsOf = () => (sendNotification as unknown as { opts: Record<string, unknown> }).opts;
  const event = {
    name: "notification.requested",
    data: { userId: "user-1", postJobId: "job-1" },
  };

  beforeEach(() => {
    deliverNotificationMock.mockReset();
    deliverNotificationMock.mockResolvedValue(undefined);
  });

  it("keeps its id and is throttled to 8 run starts a second, with 4 retries", () => {
    const opts = optsOf();

    expect(opts.id).toBe("send-notification");
    expect(opts.throttle).toEqual({ limit: 8, period: "1s", burst: 1 });
    expect(opts.retries).toBe(4);
  });

  it("delivers inside the deliver-notification step with the run-scoped idempotency key", async () => {
    const step = fakeStep();

    const out = await handlerOf(sendNotification)({ event, step });

    expect(out).toEqual({ postJobId: "job-1" });
    expect(step.order).toEqual(["run:deliver-notification"]);
    expect(deliverNotificationMock).toHaveBeenCalledTimes(1);
    expect(deliverNotificationMock).toHaveBeenCalledWith({
      userId: "user-1",
      postJobId: "job-1",
      idempotencyKey: "post-outcome/run-1",
    });
  });

  it("another run of the same job uses its own key (a retry is a new outcome)", async () => {
    await handlerOf(sendNotification)({ event, step: fakeStep(), runId: "run-2" });

    expect(deliverNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "post-outcome/run-2" }),
    );
  });

  it("a retryable delivery error makes the deliver-notification step reject, so Inngest retries it", async () => {
    deliverNotificationMock.mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 503)"));

    await expect(handlerOf(sendNotification)({ event, step: fakeStep() })).rejects.toBeInstanceOf(
      EmailRetryableError,
    );
  });
});

describe("usage limits - the workspace's X and YouTube limits in the platform step", () => {
  const publishEvent = {
    name: "post/publish.requested",
    data: { postJobId: "job-1", userId: "user-1", mediaItemId: "media-1", baseCaption: "c", perPlatformOverrides: null },
  };
  const X_REFUSAL = {
    errorCode: "X_MONTHLY_LIMIT",
    errorMessage: "This workspace has used its 30 X posts for November. X posts start again on 1 December.",
  };
  const YOUTUBE_REFUSAL = {
    errorCode: "YOUTUBE_WORKSPACE_DAILY_LIMIT",
    errorMessage:
      "This workspace has reached its limit of 10 YouTube uploads for today. Retry this upload tomorrow.",
  };

  type RunOut = { status: string; results: Array<{ platform: Platform; status: string; error?: string }> };

  function publishRun(platforms: Platform[], step = fakeStep()) {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({ id: "media-1", baseCaption: "c", deletedAt: null });
    db.connectionFindMany.mockResolvedValue(platforms.map((p) => ({ id: `conn-${p}`, platform: p })));
    stubResults(platforms);
    return handlerOf(publishToAllPlatforms)({ event: publishEvent, step }) as Promise<RunOut>;
  }

  /** The `data` of each result write, by result id. */
  function writesFor(resultId: string): Array<Record<string, unknown>> {
    return db.resultUpdate.mock.calls
      .map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> })
      .filter((c) => c.where.id === resultId)
      .map((c) => c.data);
  }

  it("under the limits nothing changes: both platforms publish", async () => {
    const out = await publishRun(["x", "youtube"]);

    expect(checkXLimitMock).toHaveBeenCalledWith(WORKSPACE.id);
    expect(checkYoutubeLimitMock).toHaveBeenCalledWith(WORKSPACE.id);
    expect(publishCtxs.map((c) => c.socialConnection.platform).sort()).toEqual(["x", "youtube"]);
    expect(consumeSlotMock).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([
      { platform: "x", status: "success" },
      { platform: "youtube", status: "success" },
    ]);
  });

  it("at the X limit the X result fails with X_MONTHLY_LIMIT, the X client is never called, and another platform still publishes", async () => {
    checkXLimitMock.mockResolvedValue(X_REFUSAL);

    const out = await publishRun(["x", "instagram"]);

    expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["instagram"]);
    expect(writesFor("result-x")).toEqual([
      { status: "failed", ...X_REFUSAL, ...CLEARS_STATE, ...HEARTBEAT },
    ]);
    expect(writesFor("result-instagram")).toEqual([
      expect.objectContaining({ status: "success", externalPostId: "ext-instagram" }),
    ]);
    expect(out.results).toEqual([
      { platform: "x", status: "failed", error: X_REFUSAL.errorMessage },
      { platform: "instagram", status: "success" },
    ]);
    // The X check is X's only: it never runs for another platform.
    expect(checkXLimitMock).toHaveBeenCalledTimes(1);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("at the YouTube limit the YouTube result fails with YOUTUBE_WORKSPACE_DAILY_LIMIT, spends no app-wide slot, and another platform still publishes", async () => {
    checkYoutubeLimitMock.mockResolvedValue(YOUTUBE_REFUSAL);

    const out = await publishRun(["x", "youtube"]);

    expect(consumeSlotMock).not.toHaveBeenCalled();
    expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["x"]);
    expect(writesFor("result-youtube")).toEqual([
      { status: "failed", ...YOUTUBE_REFUSAL, ...CLEARS_STATE, ...HEARTBEAT },
    ]);
    expect(out.results).toEqual([
      { platform: "x", status: "success" },
      { platform: "youtube", status: "failed", error: YOUTUBE_REFUSAL.errorMessage },
    ]);
    // Not a deferral: nothing waits for a reset.
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("the YouTube check runs only where a slot would be spent: not for a saved upload session of this run", async () => {
    uploadStateMocks.createStore.mockImplementation(() => ({
      load: vi.fn().mockResolvedValue({ secret: { sessionUri: "sealed" }, data: {} }),
      save: vi.fn(),
      clear: vi.fn(),
    }));

    await publishRun(["youtube"]);

    expect(checkYoutubeLimitMock).not.toHaveBeenCalled();
    expect(consumeSlotMock).not.toHaveBeenCalled();
  });
});
