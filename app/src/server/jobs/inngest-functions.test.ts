import { Prisma, type Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCaptionWithFooter } from "@/lib/captionFooter";
import { PUBLISH_STEP_BUDGET_MS } from "@/server/platforms/publishBudget";
import type { PublishContext } from "@/server/platforms/types";

// Handler-level tests for the publish pipeline's Inngest functions. vitest
// hoists vi.mock above the imports: every module inngest-functions.ts pulls in
// that touches `@/lib/db` receives this mock, and no platform API is called —
// getPlatformClient returns a stub client whose publishVideo records its ctx.
const db = vi.hoisted(() => ({
  postJobFindUnique: vi.fn(),
  postJobUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  mediaItemFindUnique: vi.fn(),
  connectionFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  resultFindMany: vi.fn(),
  resultFindUnique: vi.fn(),
  resultUpdate: vi.fn(),
  resultUpdateMany: vi.fn(),
}));
const { getPlatformClientMock, failPendingMock } = vi.hoisted(() => ({
  getPlatformClientMock: vi.fn(),
  failPendingMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: db.postJobFindUnique, update: db.postJobUpdate },
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
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: getPlatformClientMock }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/failPendingResults", () => ({
  failPendingPostJobResults: failPendingMock,
}));

import {
  failInterruptedPublishRun,
  failInterruptedRetryRun,
  publishToAllPlatforms,
  retryPlatforms,
} from "./inngest-functions";

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
  return {
    run: vi.fn(async (_id: string, cb: () => unknown) => {
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
    sendEvent: vi.fn(async () => ({ ids: [] as string[] })),
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

/** Result rows: `select: { id, platform }` lookups get ids; status lookups get statuses. */
function stubResults(platforms: Platform[], status: "success" | "failed" = "success") {
  db.resultFindMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Promise.resolve(
      select.platform
        ? platforms.map((p) => ({ id: `result-${p}`, platform: p }))
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

/** Every `postJobResult.update` data payload, in call order. */
function resultWrites(): Array<Record<string, unknown>> {
  return db.resultUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
}

const HEARTBEAT = { postJob: { update: { updatedAt: expect.any(Date) } } };

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
        data: { claimRunId: "run-1", claimedAt: expect.any(Date) },
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
        data: { claimRunId: "run-1", claimedAt: expect.any(Date) },
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

    const out = await publishRun(["x"]);

    expect(publishCtxs).toHaveLength(0);
    expect(db.resultUpdate).not.toHaveBeenCalled();
    expect(out.results).toEqual([{ platform: "x", status: "skipped" }]);
  });

  it("publishes a result that is still pending", async () => {
    const out = await publishRun(["x"]);

    expect(claimWrites()).toEqual([{ id: "result-x", claimRunId: "run-1" }]);
    expect(publishCtxs.map((c) => c.socialConnection.platform)).toEqual(["x"]);
    expect(db.resultUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "result-x",
          claimRunId: "run-1",
          OR: [{ status: "pending" }, { status: "failed", errorCode: "PUBLISH_UNCONFIRMED" }],
        },
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

// 2026-11-01 scale audit (jobs H6): every platform step CLAIMS its result row
// with one conditional write before it calls the platform. Two runs of one job
// - a duplicate event, a late original overlapping a retry - can therefore
// never both call the same platform, and a retried step (Task 2 raises the
// publish functions to retries: 3) finds its own claim and reports the post as
// unconfirmed instead of posting again.
describe("platform steps claim their result before calling the platform (jobs H6)", () => {
  type StoredResult = { status: string; claimRunId: string | null; socialConnectionId: string | null };

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
        row.claimRunId = data.claimRunId as string;
        return { count: 1 };
      },
    );
    db.resultFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? { ...row } : null;
    });
    db.resultUpdate.mockImplementation(
      async ({ where, data }: { where: { id: string; claimRunId: string }; data: { status: string } }) => {
        const row = rows.get(where.id);
        if (!row || row.claimRunId !== where.claimRunId || row.status !== "pending") {
          throw p2025();
        }
        row.status = data.status;
        return {};
      },
    );
    return rows;
  }

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
    expect(console.warn).toHaveBeenCalled();
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
