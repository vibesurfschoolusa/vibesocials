import type { Platform } from "@prisma/client";
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
  publishToAllPlatforms,
  retryPlatforms,
} from "./inngest-functions";

const WORKSPACE = { id: "ws-1", companyWebsite: null, defaultHashtags: "#brand" };

type HandlerArgs = { event: { name: string; data: Record<string, unknown> }; step: FakeStep };
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

/** The function's handler. `fn` is private in Inngest's types but plain at runtime. */
function handlerOf(fn: unknown): (args: HandlerArgs) => Promise<unknown> {
  return (fn as { fn: (args: HandlerArgs) => Promise<unknown> }).fn;
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
  db.resultUpdateMany.mockResolvedValue({ count: 0 });
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
    ["publishToAllPlatforms", publishToAllPlatforms, "publish-to-all-platforms"],
    ["retryPlatforms", retryPlatforms, "retry-platforms"],
  ] as const)("%s registers a failure handler for its own function id", (_name, fn, id) => {
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
    expect((fn as unknown as { onFailureFn?: unknown }).onFailureFn).toBe(failInterruptedPublishRun);
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
});

