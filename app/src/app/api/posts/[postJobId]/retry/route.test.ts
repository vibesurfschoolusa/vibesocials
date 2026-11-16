import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports (mirrors media/[id]/route.test.ts).
// route.ts imports `@/lib/workspace`, `@/lib/db`, `@/lib/inngest`, and
// `@/lib/rateLimit` at module scope, so all four must be mocked before
// route.ts is imported.
const {
  getWorkspaceContextMock,
  postJobFindFirstMock,
  postJobUpdateMock,
  resultUpdateManyMock,
  connectionFindUniqueMock,
  inngestSendMock,
  checkRateLimitMock,
  recomputeStatusMock,
  reserveRetryMock,
  withdrawRetryMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  postJobFindFirstMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  resultUpdateManyMock: vi.fn(),
  connectionFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  recomputeStatusMock: vi.fn(),
  reserveRetryMock: vi.fn(),
  withdrawRetryMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: postJobFindFirstMock, update: postJobUpdateMock },
    postJobResult: { updateMany: resultUpdateManyMock },
    socialConnection: { findUnique: connectionFindUniqueMock },
  },
}));

vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
// Final review F10: the enqueue-failure path recomputes the job's status under the
// row lock (failPendingResults.ts), which needs a transaction this file's db mock
// does not provide, so the helper itself is mocked.
vi.mock("@/server/jobs/failPendingResults", () => ({
  recomputeAndStorePostJobStatus: recomputeStatusMock,
}));
// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext, and the
// reconnect preflight now reads `context.workspace.id` directly instead of
// re-resolving via resolveWorkspaceForUser (the Task 2 bridge this replaces).
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));
// R6-security M3: the retry budgets are tested in server/usage/usageLog.test.ts.
vi.mock("@/server/usage/usageLog", () => ({
  reserveRetry: reserveRetryMock,
  withdrawRetry: withdrawRetryMock,
}));

import { logger } from "@/lib/logger";

import { POST, parseRetryBody } from "./route";

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}

/** Minimal NextRequest stub: the handler only calls `request.json()`. */
/** R31 pages L2: every request carries the page's workspace id (the context's "ws-1"). */
function withWorkspace(body: unknown): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? { workspaceId: "ws-1", ...body } : body;
}
function req(body: unknown, throwOnJson = false): NextRequest {
  return {
    json: async () => {
      if (throwOnJson) throw new Error("bad json");
      return withWorkspace(body);
    },
  } as unknown as NextRequest;
}

function makeJob(
  results: { platform: string; status: string; errorCode?: string | null }[],
  deletedAt: Date | null = null,
) {
  return { id: "job-1", mediaItem: { deletedAt }, results };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  postJobFindFirstMock.mockReset();
  postJobUpdateMock.mockReset();
  resultUpdateManyMock.mockReset();
  connectionFindUniqueMock.mockReset();
  inngestSendMock.mockReset();
  checkRateLimitMock.mockReset();
  recomputeStatusMock.mockReset();

  // Sensible defaults for the happy path; individual tests override.
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  postJobUpdateMock.mockResolvedValue({});
  inngestSendMock.mockResolvedValue(undefined);
  connectionFindUniqueMock.mockResolvedValue({ needsReconnect: false });
  recomputeStatusMock.mockResolvedValue({ status: "failed", successCount: 0 });
  reserveRetryMock.mockReset();
  reserveRetryMock.mockResolvedValue(null);
  withdrawRetryMock.mockReset();
  withdrawRetryMock.mockResolvedValue(undefined);
});

describe("parseRetryBody (pure)", () => {
  it("accepts retryAllFailed: true", () => {
    expect(parseRetryBody({ retryAllFailed: true })).toEqual({ kind: "all" });
  });

  it("accepts a single known platform", () => {
    expect(parseRetryBody({ platform: "tiktok" })).toEqual({
      kind: "platform",
      platform: "tiktok",
    });
  });

  it("rejects an unknown platform", () => {
    expect(parseRetryBody({ platform: "myspace" })).toEqual({
      error: "Unknown platform.",
    });
  });

  it("rejects a body with neither field", () => {
    expect("error" in parseRetryBody({})).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect("error" in parseRetryBody(null)).toBe(true);
    expect("error" in parseRetryBody("tiktok")).toBe(true);
  });

  it("retryAllFailed wins if both are provided", () => {
    expect(parseRetryBody({ retryAllFailed: true, platform: "x" })).toEqual({
      kind: "all",
    });
  });
});

describe("POST /api/posts/[postJobId]/retry", () => {
  it("returns 401 and never rate-limits or hits the DB when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited, before any DB work", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "posts/retry",
      limit: 10,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(req(undefined, true), ctx("job-1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on an invalid body", async () => {
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the job isn't in the caller's active workspace", async () => {
    postJobFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(404);
    expect(postJobFindFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
      select: expect.any(Object),
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
  });

  it("cross-workspace isolation: a job in another workspace 404s, not 403 (no existence oracle)", async () => {
    // ws-1's WHERE wouldn't match a job that actually lives in ws-2.
    postJobFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ retryAllFailed: true }), ctx("foreign-job"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 409 MEDIA_UNAVAILABLE when the media blob was soft-deleted", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }], new Date()),
    );

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("MEDIA_UNAVAILABLE");
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 409 NOTHING_TO_RETRY when retryAllFailed but no result is failed", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "success" }]),
    );

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOTHING_TO_RETRY");
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 409 RECONNECT_REQUIRED when the target connection needs reconnect", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string; platform?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("RECONNECT_REQUIRED");
    expect(body.platform).toBe("instagram");
    // Must NOT flip anything to pending — retrying a dead connection would just
    // re-fail, and we want the UI to send the user to Settings instead.
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  // R10-client-journey L1: a member can't reconnect, so the answer names the owner.
  it("a member's retry of a platform that needs reconnecting: the owner's step, not Settings", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "instagram", status: "failed" }]));
    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "The workspace owner can reconnect Instagram; then retry.",
    );
  });

  it("an owner's: the Settings step", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "instagram", status: "failed" }]));
    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));

    expect(((await res.json()) as { error?: string }).error).toBe("Reconnect Instagram in Settings before retrying.");
  });

  it("returns 409 RECONNECT_REQUIRED when the connection is gone entirely", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    connectionFindUniqueMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("RECONNECT_REQUIRED");
  });

  it("IDEMPOTENCY: returns 409 and emits no event when the conditional claim matches nothing", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }]),
    );
    // A concurrent/duplicate retry already flipped it out of `failed`.
    resultUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOTHING_TO_RETRY");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("single platform happy path: atomic claim, in_progress, event with just that platform", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { ok?: boolean; retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true, retrying: ["tiktok"] });

    // The conditional claim only touches rows still in `failed` and clears the
    // prior error fields.
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", platform: "tiktok", status: "failed" },
      // A retry starts a fresh attempt: it also releases any earlier run's claim
      // (2026-11-01 scale audit, jobs H6) so the retry run can claim the result,
      // and clears a deferral a dead run left behind (platform limits). It also
      // drops the dead run's saved upload state (chunked uploads): the retry run
      // starts the upload over, and the state holds capability URLs.
      data: {
        status: "pending",
        errorCode: null,
        errorMessage: null,
        claimRunId: null,
        claimedAt: null,
        deferredUntil: null,
        uploadState: Prisma.DbNull,
      },
    });
    // N3 fix 1: the same update marks the post as retried, so it stays on
    // Activity's "Had a problem" tab while the retry runs.
    expect(postJobUpdateMock).toHaveBeenCalledTimes(1);
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "in_progress", retriedAt: expect.any(Date) },
    });
    // 2026-11-01 scale audit (jobs H6 + H1): the event id is unique per REQUEST
    // (Inngest keeps an id for 24 h, so a fixed per-job id would swallow a
    // legitimate second retry), and the workspace feeds the shared concurrency key.
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: expect.stringMatching(/^retry-job-1-[0-9a-f-]{36}$/),
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", workspaceId: "ws-1", platforms: ["tiktok"] },
    });
  });

  // F1 H1: the deferred dispatch writes a failed RECONNECT_REQUIRED or
  // CONNECTION_GONE result (the latter with no connection) for a chosen platform
  // that was not connected. Until it is connected again the retry says so; once
  // it is, the row is claimed like any failed one, and the retry run publishes
  // through the workspace's current connection (inngest-functions.test.ts,
  // "when the workspace has reconnected the platform").
  describe("a platform the dispatch could not reach (F1 H1)", () => {
    it("asks for a reconnect while the platform is still not connected, and claims nothing", async () => {
      postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "instagram", status: "failed" }]));
      connectionFindUniqueMock.mockResolvedValue(null);

      const res = await POST(req({ platform: "instagram" }), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("RECONNECT_REQUIRED");
      expect(resultUpdateManyMock).not.toHaveBeenCalled();
    });

    it("claims the row and starts the retry once the platform is connected again", async () => {
      postJobFindFirstMock.mockResolvedValue(
        makeJob([
          { platform: "x", status: "success" },
          { platform: "instagram", status: "failed" },
        ]),
      );
      connectionFindUniqueMock.mockResolvedValue({ needsReconnect: false });
      resultUpdateManyMock.mockResolvedValue({ count: 1 });

      const res = await POST(req({ platform: "instagram" }), ctx("job-1"));

      expect(res.status).toBe(202);
      expect(resultUpdateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { postJobId: "job-1", platform: "instagram", status: "failed" } }),
      );
      expect(inngestSendMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ platforms: ["instagram"] }) }),
      );
    });
  });

  it("gives every retry request its own event id, so a second retry of one job is not deduplicated", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    await POST(req({ platform: "tiktok" }), ctx("job-1"));
    await POST(req({ platform: "tiktok" }), ctx("job-1"));

    const ids = inngestSendMock.mock.calls.map(([event]) => (event as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^retry-job-1-[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^retry-job-1-[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("takes the event's workspaceId from the request's ACTIVE workspace", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-shared-9" }));
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    await POST(req({ platform: "tiktok", workspaceId: "ws-shared-9" }), ctx("job-1"));

    const [event] = inngestSendMock.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(event.data.workspaceId).toBe("ws-shared-9");
  });

  // 2026-11-01 scale audit (jobs H6), fix round 1: `inngest.send` can throw AFTER
  // Inngest accepted the event. The retry run then starts, claims the result and
  // calls the platform while the route reverts the claim it just made. The
  // revert must leave a row a run has already claimed alone, otherwise the
  // run's success write is rejected and a live post reads "Couldn't start the
  // retry" - inviting a second retry, i.e. a second post.
  it("when the enqueue fails, reverts only the rows no run has claimed (claimRunId null)", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }, { platform: "youtube", status: "failed" }]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    inngestSendMock.mockRejectedValue(new Error("response timeout"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(body.code).toBe("RETRY_ENQUEUE_FAILED");
    expect(resultUpdateManyMock).toHaveBeenLastCalledWith({
      where: {
        postJobId: "job-1",
        platform: { in: ["tiktok", "youtube"] },
        status: "pending",
        claimRunId: null,
      },
      data: {
        status: "failed",
        errorCode: "RETRY_ENQUEUE_FAILED",
        errorMessage: "Couldn't start the retry. Please try again.",
      },
    });
  });

  // Final review F10 (M6): the route set the job `in_progress` before the enqueue
  // failed. Reverting the rows to `failed` leaves the job in_progress with no run
  // to move it, until the 2 h reconciler. The recompute (row-locked, over ALL
  // results, so a row a live run still holds keeps the job in_progress) fixes it.
  describe("when the enqueue fails, the job status is recomputed after the revert", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function failEnqueue() {
      postJobFindFirstMock.mockResolvedValue(
        makeJob([{ platform: "tiktok", status: "failed" }, { platform: "youtube", status: "failed" }]),
      );
      resultUpdateManyMock.mockResolvedValue({ count: 2 });
      inngestSendMock.mockRejectedValue(new Error("response timeout"));
      vi.spyOn(console, "error").mockImplementation(() => {});
    }

    it("recomputes the job once, after the unclaimed rows were reverted", async () => {
      failEnqueue();

      const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

      expect(res.status).toBe(500);
      expect(recomputeStatusMock).toHaveBeenCalledTimes(1);
      expect(recomputeStatusMock).toHaveBeenCalledWith("job-1");
      // The revert is the second updateMany (after the failed -> pending claims).
      const revertOrder = resultUpdateManyMock.mock.invocationCallOrder.at(-1)!;
      expect(revertOrder).toBeLessThan(recomputeStatusMock.mock.invocationCallOrder[0]);
    });

    it("still recomputes when no row was reverted (a live run claimed them all): the job stays in_progress by the recompute's own rule", async () => {
      failEnqueue();
      // Two claims succeed (tiktok, youtube), then the revert matches nothing.
      resultUpdateManyMock
        .mockReset()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

      expect(res.status).toBe(500);
      expect(resultUpdateManyMock).toHaveBeenCalledTimes(3);
      expect(recomputeStatusMock).toHaveBeenCalledWith("job-1");
    });

    it("keeps the 500 RETRY_ENQUEUE_FAILED response when the recompute itself throws, and logs it", async () => {
      failEnqueue();
      recomputeStatusMock.mockRejectedValue(new Error("deadlock detected"));
      const loggerError = vi.spyOn(logger, "error").mockImplementation(() => {});

      const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
      const body = (await res.json()) as { code?: string; error?: string };

      expect(res.status).toBe(500);
      expect(body).toEqual({
        error: "Couldn't start the retry. Please try again.",
        code: "RETRY_ENQUEUE_FAILED",
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining("recompute"),
        expect.objectContaining({ postJobId: "job-1" }),
      );
    });

    it("does not recompute when the enqueue succeeds", async () => {
      postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
      resultUpdateManyMock.mockResolvedValue({ count: 1 });

      const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

      expect(res.status).toBe(202);
      expect(recomputeStatusMock).not.toHaveBeenCalled();
    });

    it("does not recompute when nothing was claimed (409), nothing changed", async () => {
      postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
      resultUpdateManyMock.mockResolvedValue({ count: 0 });

      const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(recomputeStatusMock).not.toHaveBeenCalled();
    });
  });

  it("resolves the reconnect-preflight connection lookup from the context's workspace, not resolveWorkspaceForUser (Task 2 bridge removed)", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-42" }));

    await POST(req({ platform: "instagram", workspaceId: "ws-42" }), ctx("job-1"));

    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-42", platform: "instagram" } },
      select: { needsReconnect: true },
    });
  });

  it("retryAllFailed: claims every failed platform, runs the reconnect preflight for each, emits one event", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
        { platform: "x", status: "success" },
      ]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body.retrying).toEqual(["tiktok", "youtube"]);
    // The already-succeeded platform is never claimed.
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(2);
    // R6-security M3: the same reconnect preflight as one platform, for each failed one.
    expect(connectionFindUniqueMock).toHaveBeenCalledTimes(2);
    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "youtube" } },
      select: { needsReconnect: true },
    });
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: expect.stringMatching(/^retry-job-1-[0-9a-f-]{36}$/),
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", workspaceId: "ws-1", platforms: ["tiktok", "youtube"] },
    });
  });

  // R6-security M3: retrying everything ran no reconnect check, so a dead
  // connection was retried (and failed again) over and over.
  // R7 review, points 1 and 2: {all} uses the shared rule; a platform that
  // needs reconnecting is left out, not a reason to refuse the rest.
  it("retryAllFailed: retries the others and says which needed reconnecting", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
        { platform: "x", status: "failed" },
      ]),
    );
    connectionFindUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { platform: string } } }) =>
      where.workspaceId_platform.platform === "youtube"
        ? { needsReconnect: true }
        : where.workspaceId_platform.platform === "x"
          ? null
          : { needsReconnect: false },
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      retrying: ["tiktok"],
      leftOut: [
        { platform: "youtube", reason: "reconnect" },
        { platform: "x", reason: "reconnect" },
      ],
      notice: "YouTube left out: reconnect it in Settings. X left out: reconnect it in Settings.",
    });
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(1);
    expect((inngestSendMock.mock.calls[0][0] as { data: { platforms: string[] } }).data.platforms).toEqual(["tiktok"]);
  });

  it("retryAllFailed by a member: the notice and the refusal name the owner", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
      ]),
    );
    connectionFindUniqueMock.mockImplementation(async ({ where }: { where: { workspaceId_platform: { platform: string } } }) =>
      where.workspaceId_platform.platform === "youtube" ? { needsReconnect: true } : { needsReconnect: false },
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const accepted = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    expect(((await accepted.json()) as { notice?: string }).notice).toBe(
      "YouTube left out: the workspace owner can reconnect it.",
    );

    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });
    const refused = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe(
      "TikTok left out: the workspace owner can reconnect it. YouTube left out: the workspace owner can reconnect it.",
    );
  });

  it("retryAllFailed: X, Facebook and LinkedIn failed, Instagram unconfirmed: retries the three", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "x", status: "failed", errorCode: "SOMETHING" },
        { platform: "facebook_page", status: "failed", errorCode: null },
        { platform: "instagram", status: "failed", errorCode: "PUBLISH_UNCONFIRMED" },
        { platform: "linkedin", status: "failed", errorCode: null },
      ]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      retrying: ["x", "facebook_page", "linkedin"],
      leftOut: [{ platform: "instagram", reason: "unconfirmed" }],
      notice: "Instagram left out: check whether it posted first.",
    });
    const claimed = resultUpdateManyMock.mock.calls.map(([args]) => args.where.platform);
    expect(claimed).toEqual(["x", "facebook_page", "linkedin"]);
  });

  it("retryAllFailed: only unconfirmed or needs-reconnect platforms left: refused with the reason, nothing claimed", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "instagram", status: "failed", errorCode: "PUBLISH_UNCONFIRMED" },
        { platform: "x", status: "failed", errorCode: null },
      ]),
    );
    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Instagram left out: check whether it posted first. X left out: reconnect it in Settings.",
      code: "RECONNECT_REQUIRED",
      platform: "x",
      leftOut: [
        { platform: "instagram", reason: "unconfirmed" },
        { platform: "x", reason: "reconnect" },
      ],
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(reserveRetryMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("retryAllFailed: only an unconfirmed platform left: refused, saying to check it first", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "instagram", status: "failed", errorCode: "PUBLISH_UNCONFIRMED" }]));

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "Instagram left out: check whether it posted first.",
      code: "NOTHING_TO_RETRY",
    });
  });

  it("retryAllFailed: only the platforms actually claimed (count>0) go into the event", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
      ]),
    );
    // tiktok flips, youtube was already claimed by a concurrent retry.
    resultUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body.retrying).toEqual(["tiktok"]);
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: expect.stringMatching(/^retry-job-1-[0-9a-f-]{36}$/),
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", workspaceId: "ws-1", platforms: ["tiktok"] },
    });
  });
});

// 2026-11-09: publishing no longer waits for a verified email. Posting needs
// the person's own platform accounts connected through each platform's sign-in,
// and Meta's reviewers register with any email address, then publish.
describe("POST /api/posts/[postJobId]/retry — an unverified email may retry", () => {
  beforeEach(() => {
    // Email is deliverable, and the fixture user has no emailVerifiedAt.
    vi.stubEnv("RESEND_API_KEY", "re_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries a failed platform for a user who hasn't verified their email", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});

// 07a review round: a post with several photos is refused up front, with the
// same 409 as a single post whose media was deleted, when any photo is gone.
describe("POST /api/posts/[postJobId]/retry - a post with several photos (07a)", () => {
  const row = (position: number, id: string, deletedAt: Date | null = null) => ({
    position,
    mediaItem: { id, deletedAt },
  });
  function multiJob(media: ReturnType<typeof row>[]) {
    return {
      ...makeJob([{ platform: "tiktok", status: "failed" }]),
      mediaItemId: "m1",
      media,
    };
  }

  it("reads the photos in the same query as the job", async () => {
    postJobFindFirstMock.mockResolvedValue(null);

    await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(postJobFindFirstMock.mock.calls[0][0].select).toMatchObject({
      mediaItemId: true,
      media: {
        orderBy: { position: "asc" },
        select: { position: true, mediaItem: { select: { id: true, deletedAt: true } } },
      },
    });
  });

  it.each([
    ["a deleted second photo", [row(0, "m1"), row(1, "m2", new Date())]],
    ["a deleted first photo", [row(0, "m1", new Date()), row(1, "m2")]],
    ["a missing photo (a gap in the positions)", [row(0, "m1"), row(2, "m3")]],
    ["a post left with one photo row", [row(0, "m1")]],
  ])("refuses with 409 MEDIA_UNAVAILABLE for %s", async (_name, media) => {
    postJobFindFirstMock.mockResolvedValue(multiJob(media));

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "This post's media is no longer available — recreate the post.",
      code: "MEDIA_UNAVAILABLE",
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("retries a post whose photos are all there", async () => {
    postJobFindFirstMock.mockResolvedValue(multiJob([row(0, "m1"), row(1, "m2"), row(2, "m3")]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/posts/[postJobId]/retry - a post without a file", () => {
  it("retries a text post: no media to check, the claim and the event as for any post", async () => {
    postJobFindFirstMock.mockResolvedValue({
      id: "job-1",
      mediaItemId: null,
      mediaItem: null,
      media: [],
      results: [{ platform: "x", status: "failed" }],
    });
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "x" }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "post/retry.requested",
        data: expect.objectContaining({ postJobId: "job-1", platforms: ["x"] }),
      }),
    );
  });
});

// N3 fix 1: a retried post keeps its place on Activity's "Had a problem" tab.
describe("POST /api/posts/[postJobId]/retry - retriedAt (N3)", () => {
  it("sets retriedAt in the one update that sets in_progress, at the time of the claim", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    const before = Date.now();

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(postJobUpdateMock).toHaveBeenCalledTimes(1);
    const [arg] = postJobUpdateMock.mock.calls[0] as [{ where: unknown; data: { status: string; retriedAt: Date } }];
    expect(arg.where).toEqual({ id: "job-1" });
    expect(Object.keys(arg.data).sort()).toEqual(["retriedAt", "status"]);
    expect(arg.data.status).toBe("in_progress");
    expect(arg.data.retriedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(arg.data.retriedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("sets nothing on a 409 NOTHING_TO_RETRY", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(postJobUpdateMock).not.toHaveBeenCalled();
  });

  it("the revert path is unchanged: one job update, the same row revert, then the recompute", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    inngestSendMock.mockRejectedValue(new Error("response timeout"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(postJobUpdateMock).toHaveBeenCalledTimes(1);
    expect(resultUpdateManyMock).toHaveBeenLastCalledWith({
      where: { postJobId: "job-1", platform: { in: ["tiktok"] }, status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "RETRY_ENQUEUE_FAILED",
        errorMessage: "Couldn't start the retry. Please try again.",
      },
    });
    expect(recomputeStatusMock).toHaveBeenCalledWith("job-1");
  });
});

// R7-security L1 and the R7 review, point 7: a retry request is one run,
// recorded and then checked (reserveRetry), taken back when it does not go.
describe("POST /api/posts/[postJobId]/retry - the retry budgets", () => {
  it("refuses with the budget's sentence before claiming anything", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    const sentence =
      "This post has been retried 3 times today, the most for one day. Try again tomorrow. Retry all failed retries every failed platform of a post at once and counts as one retry.";
    reserveRetryMock.mockResolvedValue({ error: sentence, code: "POST_RETRY_LIMIT" });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: sentence, code: "POST_RETRY_LIMIT" });
    expect(reserveRetryMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      postJobId: "job-1",
      requestId: expect.any(String),
      now: expect.any(Date),
      // Second look, point 1: so an owner held back by their own number reads "you".
      viewerUserId: "user-1",
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
    // reserveRetry removes its own row when it refuses.
    expect(withdrawRetryMock).not.toHaveBeenCalled();
  });

  it("reserves the run before the claim and the hand-over, under the event's own request id", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(202);
    const { id } = inngestSendMock.mock.calls[0][0] as { id: string };
    expect(reserveRetryMock.mock.calls[0][0].requestId).toBe(id.replace(/^retry-job-1-/, ""));
    expect(reserveRetryMock.mock.invocationCallOrder[0]).toBeLessThan(resultUpdateManyMock.mock.invocationCallOrder[0]);
    expect(withdrawRetryMock).not.toHaveBeenCalled();
  });

  it("Retry all failed with 4 failed platforms: one reservation, one run, every claimed platform in it", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "x", status: "failed" },
        { platform: "facebook_page", status: "failed" },
        { platform: "instagram", status: "failed" },
        { platform: "linkedin", status: "failed" },
        { platform: "youtube", status: "success" },
      ]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, retrying: ["x", "facebook_page", "instagram", "linkedin"] });
    expect(reserveRetryMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("takes back that request's run when the retry could not be started", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    inngestSendMock.mockRejectedValue(new Error("inngest down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(500);
    const { requestId } = reserveRetryMock.mock.calls[0][0] as { requestId: string };
    expect(withdrawRetryMock).toHaveBeenCalledWith({ postJobId: "job-1", requestId });
  });

  it("takes back the run when nothing was claimed (a double click)", async () => {
    postJobFindFirstMock.mockResolvedValue(makeJob([{ platform: "tiktok", status: "failed" }]));
    resultUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(409);
    const { requestId } = reserveRetryMock.mock.calls[0][0] as { requestId: string };
    expect(withdrawRetryMock).toHaveBeenCalledWith({ postJobId: "job-1", requestId });
  });
});

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
describe("POST /api/posts/[postJobId]/retry: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no post is read", async () => {
    const res = await POST({ json: async () => ({ platform: "instagram" }) } as unknown as NextRequest, ctx("job-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no post is read", async () => {
    const res = await POST(req({ platform: "instagram", workspaceId: "ws-2" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });
});
