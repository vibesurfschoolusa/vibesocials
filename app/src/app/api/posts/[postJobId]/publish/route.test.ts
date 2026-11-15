import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace`,
// db, inngest, rateLimit, and posting at module scope; `@/lib/scheduling`
// stays REAL (pure guards/validation the handler relies on).
const {
  getWorkspaceContextMock,
  checkRateLimitMock,
  findFirstMock,
  updateManyMock,
  connectionCountMock,
  inngestSendMock,
  prepareDispatchMock,
  notifyOwnersMock,
  failPendingMock,
  checkDailyPostLimitMock,
  transactionMock,
  resultFindFirstMock,
  reserveSendNowMock,
  releaseMock,
} = vi.hoisted(() => ({
  reserveSendNowMock: vi.fn(),
  releaseMock: vi.fn(),
  transactionMock: vi.fn(),
  resultFindFirstMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  connectionCountMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
  notifyOwnersMock: vi.fn(),
  failPendingMock: vi.fn(),
  checkDailyPostLimitMock: vi.fn(),
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, updateMany: updateManyMock },
    socialConnection: { count: connectionCountMock },
    postJobResult: { findFirst: resultFindFirstMock },
    $transaction: transactionMock,
  },
}));
// Keep the REAL caption helpers (resolvePlatformCaptions, used for the owners'
// approval-request email); only the DB-touching dispatch is mocked.
vi.mock("@/server/jobs/posting", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/posting")>(
    "@/server/jobs/posting",
  );
  return { ...actual, prepareDeferredPostJobDispatch: prepareDispatchMock };
});
// Second look at T1, item 1: the reservation before the claim has its own suite (pairRule.test.ts).
vi.mock("../pairRule", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pairRule")>()),
  reserveSendNow: reserveSendNowMock,
  releaseReservation: releaseMock,
}));
// Usage limits (2026-11-10): the count has its own suite (workspaceUsage.test.ts).

vi.mock("@/server/usage/workspaceUsage", () => ({
  checkDailyPostLimit: checkDailyPostLimitMock,
}));
vi.mock("@/server/notifications/approvalRequested", () => ({
  notifyOwnersOfApprovalRequest: notifyOwnersMock,
}));
// Keep the REAL DISPATCH_FAILURE constant; only the DB-touching helper is mocked.
vi.mock("@/server/jobs/failPendingResults", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/failPendingResults")>(
    "@/server/jobs/failPendingResults",
  );
  return { ...actual, failPendingPostJobResults: failPendingMock };
});

import { prisma } from "@/lib/db";

import { POST } from "./route";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const SUBMITTED = new Date("2026-11-01T09:00:00Z");
const UPDATED = new Date("2026-11-01T09:30:00Z");
/** Scheduling a post again clears every client mark: it is a new post to look over (client review link). */
const CLEAR_CLIENT_CHANGE = { clientApprovedAt: null, clientChangeRequestedAt: null, clientNote: null };

/** The ownership/approval read's row; defaults to a plain draft. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "draft",
    scheduledFor: null,
    createdAt: new Date(),
    submittedForApprovalAt: null,
    approvedAt: null,
    baseCaption: "Member's caption",
    updatedAt: UPDATED,
    ...overrides,
  };
}

/** A member in a workspace that requires owner approval. */
function memberInApprovalWorkspace() {
  return makeWorkspaceContext({
    userId: "member-1",
    email: "sam@example.com",
    name: "Sam",
    role: "member",
    requireApproval: true,
  });
}

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}
function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  connectionCountMock.mockReset();
  inngestSendMock.mockReset();
  prepareDispatchMock.mockReset();
  notifyOwnersMock.mockReset();
  failPendingMock.mockReset();
  checkDailyPostLimitMock.mockReset();
  checkDailyPostLimitMock.mockResolvedValue(null);
  reserveSendNowMock.mockReset();
  reserveSendNowMock.mockImplementation(async ({ postJobIds }: { postJobIds: string[] }) => ({
    ok: true,
    reserved: { postJobIds, day: new Date("2026-11-14T15:00:00Z") },
  }));
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());

  notifyOwnersMock.mockResolvedValue(undefined);
  failPendingMock.mockResolvedValue({ failedCount: 2, status: "failed" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  updateManyMock.mockResolvedValue({ count: 1 });
  connectionCountMock.mockResolvedValue(2);
  inngestSendMock.mockResolvedValue(undefined);
  prepareDispatchMock.mockResolvedValue({
    ok: true,
    event: {
      postJobId: "job-1",
      userId: "user-1",
      // prepareDeferredPostJobDispatch reads it off the job row (the route has
      // already scoped that job to the caller's workspace).
      workspaceId: "ws-1",
      mediaItemId: "m1",
      baseCaption: "c",
      perPlatformOverrides: null,
    },
  });
});

describe("POST /api/posts/[postJobId]/publish", () => {
  it("401s before any work when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("429s under the posts/publish bucket when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "posts/publish" }),
    );
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't in the caller's active workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("cross-workspace isolation: scopes the ownership read to workspaceId (not userId), and a foreign job 404s — not 403 (no existence oracle)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job

    const res = await POST(req({}), ctx("foreign-job"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: {
        status: true,
        scheduledFor: true,
        createdAt: true,
        submittedForApprovalAt: true,
        approvedAt: true,
        baseCaption: true,
        // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads.
        perPlatformOverrides: true,
        publishMetadata: true,
        mediaItem: { select: { baseCaption: true, perPlatformOverrides: true, deletedAt: true } },
        updatedAt: true,
        // F1 H3: a failed post with no results was never sent; Post now may send it.
        _count: { select: { results: true } },
        // Review round 2, item 1: a post whose media is gone is refused like Retry refuses it.
        mediaItemId: true,
        media: {
          orderBy: { position: "asc" },
          select: { position: true, mediaItem: { select: { id: true, deletedAt: true } } },
        },
        // R3-client-journey M1: where a Feed and Story card finds its other half.
        storyOfPostJobId: true,
      },
    });
  });

  // --- schedule-a-draft path ---
  it("schedules a draft: draft → scheduled with the validated time", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("scheduled");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "draft" },
      data: { status: "scheduled", scheduledFor: new Date(FUTURE), ...CLEAR_CLIENT_CHANGE },
    });
    // Scheduling sends no event now — the cron dispatches when due.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("scheduling a draft the client asked to change clears the request in the same update", async () => {
    findFirstMock.mockResolvedValue(jobRow({ scheduledFor: new Date(FUTURE) }));

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({
      status: "scheduled",
      clientApprovedAt: null,
      clientChangeRequestedAt: null,
      clientNote: null,
    });
  });

  it("submitting for approval keeps the client's note, so the owner sees it while deciding", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "member", requireApproval: true }),
    );
    findFirstMock.mockResolvedValue(jobRow({ scheduledFor: new Date(FUTURE) }));

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(202);
    const { data } = updateManyMock.mock.calls[0][0];
    expect(data.status).toBe("draft");
    for (const field of ["clientApprovedAt", "clientChangeRequestedAt", "clientNote"]) {
      expect(data).not.toHaveProperty(field);
    }
  });

  it("rejects scheduling a non-draft (409 NOT_A_DRAFT)", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_A_DRAFT");
  });

  it("400s on an invalid/past scheduledFor", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const past = new Date(Date.now() - 1000).toISOString();
    const res = await POST(req({ scheduledFor: past }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // --- publish-now path ---
  it("publishes a draft now: claims {draft,scheduled}→in_progress, sends the event, 202", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
      data: { status: "in_progress", scheduledFor: expect.any(Date) },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1", { reserved: true });
    // 2026-11-01 scale audit (jobs H6 + H1): stable event id, the workspace for
    // the shared concurrency key, and the Post-now priority flag.
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({ postJobId: "job-1", workspaceId: "ws-1", immediate: true }),
    });
  });

  it("sends the same event id on a second publish of the same job, so Inngest drops the duplicate", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    await POST(req({}), ctx("job-1"));
    await POST(req({}), ctx("job-1"));

    const ids = inngestSendMock.mock.calls.map(([event]) => (event as { id: string }).id);
    expect(ids).toEqual(["publish-job-1", "publish-job-1"]);
  });

  // The body is optional: publish-now sends none, so an empty / non-JSON /
  // non-object body (readJsonObject -> null) must mean "no body", never a 4xx/5xx.
  it.each([
    ["an empty body (publish-now sends none)", () => Promise.reject(new SyntaxError("Unexpected end of JSON input"))],
    ["null", () => Promise.resolve(null)],
    ["an array", () => Promise.resolve([1])],
    ["a number", () => Promise.resolve(5)],
  ])("treats %s as no body and publishes now", async (_label, json) => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST({ json } as unknown as NextRequest, ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalled();
  });

  it("publishes a SCHEDULED job now too (Queue 'Publish now')", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalled();
  });

  it("scopes the up-front connection check to the WORKSPACE, not the caller (Team Workspaces, Task 4 — a member who didn't personally connect anything must still see the workspace's shared connections)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    await POST(req({}), ctx("job-1"));

    expect(connectionCountMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
  });

  it("400s NO_CONNECTIONS and leaves the draft intact when there are no connections", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    connectionCountMock.mockResolvedValue(0);

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_CONNECTIONS");
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("409s NOT_PUBLISHABLE when the status isn't draft/scheduled", async () => {
    findFirstMock.mockResolvedValue({ status: "completed" });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PUBLISHABLE");
    expect(connectionCountMock).not.toHaveBeenCalled();
  });

  it("409s when the atomic claim loses the race (count 0)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  // Review of T1, item 1: the reservation as it went out refused it (a press at the limit's edge).
  it("429s with the limit's sentence when the reservation refuses it; no event", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const refusal = {
      errorCode: "SERVICE_DAILY_POST_LIMIT",
      errorMessage: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
    };
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1", refusal });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: refusal.errorMessage, code: refusal.errorCode });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("409s when a connection vanished between the count and prepare (prepare NO_CONNECTIONS)", async () => {

    findFirstMock.mockResolvedValue({ status: "draft" });
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  // F1 H1: every chosen platform needed reconnecting (or was removed). Each has
  // a failed result with its sentence, so the answer says where to look.
  it("answers a post none of whose platforms is connected with a plain sentence pointing at Activity", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({}), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({
      code: "NO_CONNECTIONS",
      error: "Nothing was posted: none of this post's platforms is connected. Activity shows what to reconnect.",
    });
  });

  // F1 H3: a scheduled post that failed on our side before any platform was
  // tried has no results, so Retry has nothing to retry. Send again (Activity) calls this route.
  describe("a scheduled post that failed before any platform was tried (F1 H3)", () => {
    it("Post now claims it (failed with no results) and sends it", async () => {
      findFirstMock.mockResolvedValue(jobRow({ status: "failed", _count: { results: 0 } }));

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(202);
      expect(updateManyMock).toHaveBeenCalledWith({
        where: { id: "job-1", workspaceId: "ws-1", status: "failed", results: { none: {} }, updatedAt: UPDATED },
        data: { status: "in_progress", scheduledFor: expect.any(Date), retriedAt: expect.any(Date) },
      });
      expect(prepareDispatchMock).toHaveBeenCalledWith("job-1", { reserved: true });
      expect(inngestSendMock).toHaveBeenCalledTimes(1);
    });

    // Live check: a post from months ago is not sent again; nothing is claimed.
    it("refuses Send again for a post older than a week", async () => {
      findFirstMock.mockResolvedValue(
        jobRow({ status: "failed", _count: { results: 0 }, scheduledFor: new Date(Date.now() - 8 * 86_400_000) }),
      );

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "This post is too old to send again. Create it again.",
        code: "TOO_OLD",
      });
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    // Review round 2, item 1: the same answer Retry gives, before anything is claimed.
    it("refuses Send again for a post whose media was swept, with Retry's MEDIA_UNAVAILABLE answer", async () => {
      findFirstMock.mockResolvedValue(
        jobRow({
          status: "failed",
          _count: { results: 0 },
          mediaItemId: "m1",
          mediaItem: { baseCaption: "c", perPlatformOverrides: null, deletedAt: new Date("2026-11-01T00:00:00Z") },
          media: [],
        }),
      );

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "This post's media is no longer available — recreate the post.",
        code: "MEDIA_UNAVAILABLE",
      });
      expect(updateManyMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("refuses one whose second photo was swept the same way", async () => {
      findFirstMock.mockResolvedValue(
        jobRow({
          status: "failed",
          _count: { results: 0 },
          mediaItemId: "m1",
          mediaItem: { baseCaption: "c", perPlatformOverrides: null, deletedAt: null },
          media: [
            { position: 0, mediaItem: { id: "m1", deletedAt: null } },
            { position: 1, mediaItem: { id: "m2", deletedAt: new Date("2026-11-01T00:00:00Z") } },
          ],
        }),
      );

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("MEDIA_UNAVAILABLE");
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    // Review round 2, item 5: like Retry, so Activity keeps it on "Had a problem".
    it("sets retriedAt in the Send again claim", async () => {
      findFirstMock.mockResolvedValue(jobRow({ status: "failed", _count: { results: 0 } }));

      await POST(req({}), ctx("job-1"));

      expect(updateManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "in_progress", scheduledFor: expect.any(Date), retriedAt: expect.any(Date) },
        }),
      );
    });

    it("still refuses a failed post that has results: Retry is for that", async () => {
      findFirstMock.mockResolvedValue(jobRow({ status: "failed", _count: { results: 2 } }));

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_PUBLISHABLE");
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it("409s when the post changed since it was read (the claim misses)", async () => {
      findFirstMock.mockResolvedValue(jobRow({ status: "failed", _count: { results: 0 } }));
      updateManyMock.mockResolvedValue({ count: 0 });

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("does not let a member send one nobody approved while approval is on", async () => {
      getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
      findFirstMock.mockResolvedValue(jobRow({ status: "failed", _count: { results: 0 } }));

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        code: "AWAITING_APPROVAL",
        error: "An owner needs to approve this post first. Ask an owner to use Send again.",
      });
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it("lets a member send one an owner approved", async () => {
      getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
      findFirstMock.mockResolvedValue(
        jobRow({ status: "failed", approvedAt: SUBMITTED, submittedForApprovalAt: SUBMITTED, _count: { results: 0 } }),
      );

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(202);
    });
  });

  // --- dispatch failure (2026-11-01 audit) ---
  it("503s DISPATCH_FAILED and fails the job's pending results when inngest.send throws after the claim", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirstMock.mockResolvedValue(jobRow());
    inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
    });
    expect(failPendingMock).toHaveBeenCalledWith("job-1", {
      errorCode: "DISPATCH_FAILED",
      errorMessage: "Couldn't start publishing. Please try again.",
    });
    consoleSpy.mockRestore();
  });

  it("does not touch results when the dispatch succeeds", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(202);
    expect(failPendingMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts/[postJobId]/publish — approval enforcement (2026-11-01 audit)", () => {
  beforeEach(() => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
  });

  it("bypass (a): a member's plain draft is SUBMITTED for approval, not published", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "draft",
      approvalState: "pending",
      scheduledFor: null,
    });
    // One conditional write, pinned to the version that was read.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "draft", updatedAt: UPDATED },
      data: {
        status: "draft",
        submittedForApprovalAt: expect.any(Date),
        approvedAt: null,
        approvedByUserId: null,
        scheduledFor: null,
      },
    });
    // Nothing is dispatched.
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("emails the workspace owners when it submits", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    await POST(req({}), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workspaceName: "Acme",
      submitter: expect.objectContaining({ id: "member-1", name: "Sam", email: "sam@example.com" }),
      caption: "Member's caption",
      platformCaptions: null,
    });
  });

  // 2026-11-01 audit (M1): the owners are shown the per-platform texts that
  // will publish, limited to the platforms the post targets.
  it("tells the owners the per-platform captions of the targeted platforms", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({
        perPlatformOverrides: { linkedin: "Hidden text", x: "Not targeted" },
        publishMetadata: { targetPlatforms: ["linkedin", "youtube"] },
        mediaItem: { baseCaption: "Media caption", perPlatformOverrides: { x: "Old media text" } },
      }),
    );

    await POST(req({}), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Member's caption",
        platformCaptions: { linkedin: "Hidden text" },
      }),
    );
  });

  // 2026-11-10 (Stories): a Story publishes no caption, so none is shown as going there.
  it("lists a Story platform as 'Story, no caption', even over its own override", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({
        perPlatformOverrides: { instagram: "IG text", linkedin: "Hidden text" },
        publishMetadata: { targetPlatforms: ["instagram", "linkedin"], instagram: { placement: "story" } },
      }),
    );

    await POST(req({}), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        platformCaptions: { instagram: "Story, no caption", linkedin: "Hidden text" },
      }),
    );
  });

  it("a feed post's email keeps the Instagram caption", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({
        perPlatformOverrides: { instagram: "IG text" },
        publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "feed" } },
      }),
    );

    await POST(req({}), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ platformCaptions: { instagram: "IG text" } }),
    );
  });

  it("a member scheduling a plain draft submits it with the requested time (not scheduled)", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "draft",
      approvalState: "pending",
      scheduledFor: new Date(FUTURE).toISOString(),
    });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "draft", scheduledFor: new Date(FUTURE) }),
      }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("400s an invalid requested time on submit, writing nothing", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    const past = new Date(Date.now() - 1000).toISOString();

    const res = await POST(req({ scheduledFor: past }), ctx("job-1"));

    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("bypass (b): publishing an already-pending post 409s AWAITING_APPROVAL with no state change", async () => {
    findFirstMock.mockResolvedValue(jobRow({ submittedForApprovalAt: SUBMITTED }));

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      code: "AWAITING_APPROVAL",
      error: "This post is waiting for an owner's approval.",
    });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("scheduling an already-pending post is refused too", async () => {
    findFirstMock.mockResolvedValue(jobRow({ submittedForApprovalAt: SUBMITTED }));
    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("AWAITING_APPROVAL");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("a scheduled post nobody approved is pulled back for approval, keeping its time", async () => {
    const existing = new Date(Date.now() + 2 * 60 * 60 * 1000);
    findFirstMock.mockResolvedValue(jobRow({ status: "scheduled", scheduledFor: existing }));

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      status: "draft",
      approvalState: "pending",
      scheduledFor: existing.toISOString(),
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "scheduled", updatedAt: UPDATED },
      data: expect.objectContaining({ status: "draft", scheduledFor: existing }),
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("409s and notifies nobody when the submit loses a race (count 0)", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("an APPROVED scheduled post may still be published now by a member", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, status: "in_progress" });
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("pins a member's publish-now claim to the APPROVED version it read (updatedAt)", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    await POST(req({}), ctx("job-1"));

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
        updatedAt: UPDATED,
      },
      data: { status: "in_progress", scheduledFor: expect.any(Date) },
    });
  });

  it("a concurrent edit re-hold in the read→claim window makes the claim match nothing: 409 NOT_PUBLISHABLE, nothing published", async () => {
    // Read: approved + scheduled. Meanwhile a PATCH re-held it (draft,
    // approvedAt null, new text, new updatedAt) — the pinned claim misses.
    findFirstMock.mockResolvedValue(
      jobRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PUBLISHABLE");
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("owners are never affected — an owner's draft publishes", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "owner", requireApproval: true }),
    );
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("a member publishes freely when the workspace doesn't require approval", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "member", requireApproval: false }),
    );
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});

// Ruling R10 (final review M1): publishing or scheduling a HELD post through
// this route used to write `scheduled` / `in_progress` and leave
// `submittedForApprovalAt` set. A scheduled+submitted+unapproved row is never
// claimed by the cron (R6) and couldn't be approved (the decision claim
// required a draft), so the post never went out and nothing in the UI could
// recover it.
describe("POST /api/posts/[postJobId]/publish — held posts (ruling R10)", () => {
  const HELD = () => jobRow({ submittedForApprovalAt: SUBMITTED });

  describe("approval ON + an OWNER", () => {
    beforeEach(() => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "owner", requireApproval: true }),
      );
      findFirstMock.mockResolvedValue(HELD());
    });

    it.each([
      ["publish now", {}],
      ["schedule", { scheduledFor: FUTURE }],
    ])("%s → 409 AWAITING_APPROVAL (approve or reject instead), no state change", async (_label, body) => {
      const res = await POST(req(body), ctx("job-1"));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        code: "AWAITING_APPROVAL",
        error: "This post is waiting for approval — approve or reject it instead.",
      });
      expect(updateManyMock).not.toHaveBeenCalled();
      expect(connectionCountMock).not.toHaveBeenCalled();
      expect(prepareDispatchMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
      expect(notifyOwnersMock).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["an owner", "owner"],
    ["a member", "member"],
  ] as const)("approval OFF + %s", (_label, role) => {
    beforeEach(() => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role, requireApproval: false }),
      );
      findFirstMock.mockResolvedValue(HELD());
    });

    it("schedules it and clears the submission in the SAME conditional write", async () => {
      const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        status: "scheduled",
        scheduledFor: new Date(FUTURE).toISOString(),
      });
      expect(updateManyMock).toHaveBeenCalledTimes(1);
      expect(updateManyMock).toHaveBeenCalledWith({
        where: { id: "job-1", workspaceId: "ws-1", status: "draft", updatedAt: UPDATED },
        data: {
          status: "scheduled",
          scheduledFor: new Date(FUTURE),
          ...CLEAR_CLIENT_CHANGE,
          submittedForApprovalAt: null,
          approvedAt: null,
        },
      });
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("publishes it now and clears the submission in the SAME conditional claim", async () => {
      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(202);
      expect(updateManyMock).toHaveBeenCalledTimes(1);
      expect(updateManyMock).toHaveBeenCalledWith({
        where: {
          id: "job-1",
          workspaceId: "ws-1",
          status: { in: ["scheduled", "draft"] },
          updatedAt: UPDATED,
        },
        data: {
          status: "in_progress",
          scheduledFor: expect.any(Date),
          submittedForApprovalAt: null,
          approvedAt: null,
        },
      });
      expect(inngestSendMock).toHaveBeenCalledTimes(1);
    });

    it("409s without dispatching when the post changed after it was read (claim misses)", async () => {
      updateManyMock.mockResolvedValue({ count: 0 });

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      expect(prepareDispatchMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
    });
  });

  // The schedule claim decides from the approval columns it READ, so it must
  // land only on that version: a member submitting the same draft in between
  // would otherwise become scheduled-but-unapproved (stuck) again.
  it("pins a plain draft's schedule claim to the version it read (updatedAt), clearing nothing", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "draft", updatedAt: UPDATED },
      data: { status: "scheduled", scheduledFor: new Date(FUTURE), ...CLEAR_CLIENT_CHANGE },
    });
  });

  it("pins an owner's publish-now claim to the version it read too", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "owner", requireApproval: true }),
    );
    findFirstMock.mockResolvedValue(jobRow());

    await POST(req({}), ctx("job-1"));

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
        updatedAt: UPDATED,
      },
      data: { status: "in_progress", scheduledFor: expect.any(Date) },
    });
  });

  it("409s NOT_A_DRAFT when the pinned schedule claim misses (changed in the meantime)", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_A_DRAFT");
  });
});

// 2026-11-09: publishing no longer waits for a verified email. Posting needs
// the person's own platform accounts connected through each platform's sign-in,
// and Meta's reviewers register with any email address, then publish.
describe("POST /api/posts/[postJobId]/publish — an unverified email may publish", () => {
  beforeEach(() => {
    // Email is deliverable, and the fixture user has no emailVerifiedAt.
    vi.stubEnv("RESEND_API_KEY", "re_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("publishes a draft now for a user who hasn't verified their email", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/posts/[postJobId]/publish — daily post limit (usage limits)", () => {
  const NOW_SENTENCE =
    "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.";
  const SCHEDULE_SENTENCE =
    "That day already has 20 posts, which is this workspace's daily limit. Pick another day.";

  it("scheduling a draft checks its new day, leaving the post itself out", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      day: new Date(FUTURE),
      mode: "schedule",
      excludePostJobId: "job-1",
      viewerUserId: expect.any(String),
    });
  });

  it("scheduling at the limit answers 429 with the sentence and code, and schedules nothing", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    checkDailyPostLimitMock.mockResolvedValue({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("publishing now checks today, leaving the post itself out", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "scheduled", scheduledFor: new Date(FUTURE) }));
    const before = Date.now();

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    const args = checkDailyPostLimitMock.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: "ws-1", mode: "now", excludePostJobId: "job-1" });
    expect(args.day.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("publishing now at the limit answers 429 with the sentence and code, and claims nothing", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    checkDailyPostLimitMock.mockResolvedValue({ error: NOW_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: NOW_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("a member's submission for approval is not checked (the post stays a draft)", async () => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
    findFirstMock.mockResolvedValue(jobRow());

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts/[postJobId]/publish — publishing now counts toward today (usage limits)", () => {
  const OLD = new Date("2026-01-05T10:00:00Z");
  const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000);

  /** The `scheduledFor` the publish-now claim wrote. */
  function claimedScheduledFor(): Date {
    const data = updateManyMock.mock.calls[0][0].data as { scheduledFor?: unknown };
    expect(data.scheduledFor).toBeInstanceOf(Date);
    return data.scheduledFor as Date;
  }

  it("an old draft published now is stamped with the time it goes out, the same instant the limit was checked for", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "draft", scheduledFor: null, createdAt: OLD }));
    const before = Date.now();

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    const stamped = claimedScheduledFor();
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(Date.now());
    expect(checkDailyPostLimitMock.mock.calls[0][0].day).toEqual(stamped);
    expect(updateManyMock.mock.calls[0][0].data.status).toBe("in_progress");
  });

  it("an old draft published now is refused at today's limit", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "draft", scheduledFor: null, createdAt: OLD }));
    checkDailyPostLimitMock.mockResolvedValue({
      error:
        "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.",
      code: "WORKSPACE_DAILY_POST_LIMIT",
    });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(checkDailyPostLimitMock.mock.calls[0][0]).toMatchObject({ mode: "now" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("a post scheduled for tomorrow and published now moves to today: its scheduledFor becomes now, not tomorrow", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "scheduled", scheduledFor: TOMORROW }));
    const before = Date.now();

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    const stamped = claimedScheduledFor();
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThan(TOMORROW.getTime());
    expect(stamped.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("POST /api/posts/[postJobId]/publish - a post without a file", () => {
  it("promotes a text draft: the event carries the text and no file", async () => {
    findFirstMock.mockResolvedValue({ status: "draft", mediaItemId: null, mediaItem: null });
    prepareDispatchMock.mockResolvedValue({
      ok: true,
      event: {
        postJobId: "job-1",
        userId: "user-1",
        workspaceId: "ws-1",
        mediaItemId: null,
        baseCaption: "Wind is onshore",
        perPlatformOverrides: null,
      },
    });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: {
        postJobId: "job-1",
        userId: "user-1",
        workspaceId: "ws-1",
        mediaItemId: null,
        baseCaption: "Wind is onshore",
        perPlatformOverrides: null,
        immediate: true,
      },
    });
  });
});

// R3-client-journey M1: a Feed and Story post is one Queue card. With
// includePair, Publish now, Submit for approval and scheduling a draft take
// both halves in one transaction (pairRule.ts).
describe("POST /api/posts/[postJobId]/publish - a Feed and Story card", () => {
  const STORY_UPDATED = new Date("2026-11-01T09:31:00Z");
  function storyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "story-1",
      storyOfPostJobId: "job-1",
      status: "draft",
      scheduledFor: null,
      createdAt: new Date(),
      updatedAt: STORY_UPDATED,
      submittedForApprovalAt: null,
      approvedAt: null,
      baseCaption: "Member's caption",
      perPlatformOverrides: null,
      publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
      coverImageUrl: null,
      mediaItem: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    prepareDispatchMock.mockImplementation(async (id: string) => ({
      ok: true,
      event: { postJobId: id, userId: "user-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
    }));
  });

  it("publish now claims both halves once each, in one transaction, and sends both events in one send", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "in_progress",
      otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story is publishing too." },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls).toEqual([
      [
        {
          where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] }, updatedAt: UPDATED },
          data: { status: "in_progress", scheduledFor: expect.any(Date) },
        },
      ],
      [
        {
          where: { id: "story-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] }, updatedAt: STORY_UPDATED },
          data: { status: "in_progress", scheduledFor: expect.any(Date) },
        },
      ],
    ]);
    expect(prepareDispatchMock.mock.calls).toEqual([["job-1", { reserved: true }], ["story-1", { reserved: true }]]);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: "publish-job-1" }),
      expect.objectContaining({ id: "publish-story-1" }),
    ]);
  });

  it("publish now counts the pair as two posts today, neither against itself", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    await POST(req({ includePair: true }), ctx("job-1"));

    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "now", excludePostJobId: ["job-1", "story-1"], alsoOnDay: 1 }),
    );
  });

  it("a Story already publishing is left alone and named; only the feed post is claimed and sent", async () => {
    findFirstMock
      .mockResolvedValueOnce(jobRow({ storyOfPostJobId: null }))
      .mockResolvedValueOnce(storyRow({ status: "in_progress" }));

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story has already started publishing, so it was not published.",
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledWith(expect.objectContaining({ id: "publish-job-1" }));
  });

  it("an event send that fails fails both halves' pending results", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    inngestSendMock.mockRejectedValue(new Error("inngest down"));

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(503);
    expect(failPendingMock.mock.calls.map((call) => call[0])).toEqual(["job-1", "story-1"]);
  });

  // Review of R3: one half had nothing it could send but the other went out.
  it("the feed post has nothing sendable but its Story is sent: success, saying what went out and what did not", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) =>
      id === "job-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "user-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
    );
    resultFindFirstMock.mockResolvedValue({ errorMessage: "Reconnect Facebook Page in Settings." });

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("in_progress");
    expect(body.message).toBe("The Story is being sent. The feed post was not: Reconnect Facebook Page in Settings.");
    expect(body.otherHalf).toEqual(expect.objectContaining({ id: "story-1", changed: true }));
    expect(resultFindFirstMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "failed" },
      orderBy: { createdAt: "asc" },
      select: { errorMessage: true, platform: true },
    });
    expect(inngestSendMock).toHaveBeenCalledWith(expect.objectContaining({ id: "publish-story-1" }));
  });

  it("the Story has nothing sendable but the feed post is sent: success, saying so", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) =>
      id === "story-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "user-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
    );
    resultFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect((await res.json()).message).toBe(
      "The feed post is being sent. The Story was not: none of its platforms is connected. Activity shows what to reconnect.",
    );
  });

  it("neither half has anything sendable: Nothing was posted, as before", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Nothing was posted/);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  // R11-publishing L1: a member (approval off) pressing Publish now reads who can fix it.
  describe("a member publishing now", () => {
    const member = () => makeWorkspaceContext({ userId: "member-1", role: "member", requireApproval: false });
    const storySendable = async (id: string) =>
      id === "job-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } };

    it("one half not sendable: the stored reconnect sentence in its member form", async () => {
      getWorkspaceContextMock.mockResolvedValue(member());
      findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
      prepareDispatchMock.mockImplementation(storySendable);
      resultFindFirstMock.mockResolvedValue({ errorMessage: "Reconnect Facebook Page in Settings, then retry.", platform: "facebook_page" });

      const res = await POST(req({ includePair: true }), ctx("job-1"));

      expect(res.status).toBe(202);
      expect((await res.json()).message).toBe(
        "The Story is being sent. The feed post was not: The workspace owner can reconnect Facebook Page; then retry.",
      );
    });

    it("the other half not sendable: its note says the owner can reconnect", async () => {
      getWorkspaceContextMock.mockResolvedValue(member());
      findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
      prepareDispatchMock.mockImplementation(async (id: string) =>
        id === "story-1"
          ? { ok: false, reason: "NO_CONNECTIONS" }
          : { ok: true, event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
      );
      resultFindFirstMock.mockResolvedValue(null);

      const body = await (await POST(req({ includePair: true }), ctx("job-1"))).json();

      expect(body.message).toBe(
        "The feed post is being sent. The Story was not: none of its platforms is connected. Activity shows what didn't go out; the workspace owner can reconnect it.",
      );
      expect(body.otherHalf.note).toBe(
        "Its Story was not sent: none of its platforms is connected. Activity shows what didn't go out; the workspace owner can reconnect it.",
      );
    });

    it("nothing sendable at all: Nothing was posted, the owner can reconnect", async () => {
      getWorkspaceContextMock.mockResolvedValue(member());
      findFirstMock.mockResolvedValue({ status: "draft" });
      prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

      const res = await POST(req({}), ctx("job-1"));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(
        "Nothing was posted: none of this post's platforms is connected. Activity shows what didn't go out; the workspace owner can reconnect it.",
      );
    });

    it("nothing connected in the workspace: the owner can connect one (owner keeps its own sentence)", async () => {
      findFirstMock.mockResolvedValue({ status: "draft" });
      connectionCountMock.mockResolvedValue(0);

      getWorkspaceContextMock.mockResolvedValue(member());
      const memberRes = await POST(req({}), ctx("job-1"));
      expect(memberRes.status).toBe(400);
      await expect(memberRes.json()).resolves.toEqual({
        error: "The workspace owner can connect a platform for this workspace.",
        code: "NO_CONNECTIONS",
      });

      getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
      await expect((await POST(req({}), ctx("job-1"))).json()).resolves.toEqual({
        error: "Connect at least one platform before publishing.",
        code: "NO_CONNECTIONS",
      });
    });
  });

  it("member submit holds both halves and the owners get ONE email with the Story line", async () => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: true,
      note: "Its Story was sent for approval too.",
    });
    expect(updateManyMock.mock.calls).toEqual([
      [
        {
          where: { id: "job-1", workspaceId: "ws-1", status: "draft", updatedAt: UPDATED },
          data: expect.objectContaining({ status: "draft", submittedForApprovalAt: expect.any(Date), scheduledFor: null }),
        },
      ],
      [
        {
          where: { id: "story-1", workspaceId: "ws-1", status: "draft", updatedAt: STORY_UPDATED },
          data: expect.objectContaining({ status: "draft", submittedForApprovalAt: expect.any(Date), scheduledFor: null }),
        },
      ],
    ]);
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).toHaveBeenCalledWith(expect.objectContaining({ alsoAsStory: ["instagram"] }));
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  // R4 lows, item 3: the owners' email describes the feed post, whichever half the submit came from.
  it("member submit sent from the Story: the email lists the feed post's platforms and texts, with the Story line", async () => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
    findFirstMock
      .mockResolvedValueOnce(
        jobRow({
          storyOfPostJobId: "feed-1",
          perPlatformOverrides: null,
          publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
          mediaItem: null,
        }),
      )
      .mockResolvedValueOnce(
        storyRow({
          id: "feed-1",
          storyOfPostJobId: null,
          baseCaption: "Feed caption",
          perPlatformOverrides: { facebook_page: "Feed Facebook" },
          publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
        }),
      );

    const res = await POST(req({ includePair: true }), ctx("story-1"));

    expect(res.status).toBe(202);
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Feed caption",
        platformCaptions: { facebook_page: "Feed Facebook" },
        alsoAsStory: ["instagram"],
      }),
    );
  });

  // R4 lows, item 5: a failed send is "try again", even when this post had nothing sendable.
  it("this post had nothing sendable, the other half was prepared, and the send failed: 503 try again, not reconnect", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) =>
      id === "job-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "user-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
    );
    inngestSendMock.mockRejectedValue(new Error("inngest down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("DISPATCH_FAILED");
    consoleSpy.mockRestore();
  });

  it("member submit with a time gives both halves that time", async () => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    await POST(req({ scheduledFor: FUTURE, includePair: true }), ctx("job-1"));

    expect(updateManyMock.mock.calls.map((call) => call[0].data.scheduledFor)).toEqual([
      new Date(FUTURE),
      new Date(FUTURE),
    ]);
  });

  it("a Story already waiting for approval is left alone and the email does not name it", async () => {
    getWorkspaceContextMock.mockResolvedValue(memberInApprovalWorkspace());
    findFirstMock
      .mockResolvedValueOnce(jobRow({ storyOfPostJobId: null }))
      .mockResolvedValueOnce(storyRow({ submittedForApprovalAt: SUBMITTED }));

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story is already waiting for approval, so it was not sent for approval.",
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock.mock.calls[0][0].alsoAsStory).toBeUndefined();
  });

  it("scheduling a draft schedules both halves at that time", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    const res = await POST(req({ scheduledFor: FUTURE, includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: true,
      note: "Its Story was scheduled too.",
    });
    expect(updateManyMock.mock.calls).toEqual([
      [
        {
          where: { id: "job-1", workspaceId: "ws-1", status: "draft", updatedAt: UPDATED },
          data: { status: "scheduled", scheduledFor: new Date(FUTURE), ...CLEAR_CLIENT_CHANGE },
        },
      ],
      [
        {
          where: { id: "story-1", workspaceId: "ws-1", status: "draft", updatedAt: STORY_UPDATED },
          data: { status: "scheduled", scheduledFor: new Date(FUTURE), ...CLEAR_CLIENT_CHANGE },
        },
      ],
    ]);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "schedule", excludePostJobId: ["job-1", "story-1"], alsoOnDay: 1 }),
    );
  });

  it("without includePair publish now is exactly as before: one claim, one event, no pair read", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null }));

    const res = await POST(req({}), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "in_progress" });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(inngestSendMock).toHaveBeenCalledWith(expect.objectContaining({ id: "publish-job-1" }));
  });
});

// Second look at T1, item 1: the run is reserved before the claim, so a refusal changes nothing.
describe("POST /api/posts/[postJobId]/publish - reserved before the claim", () => {
  const FULL = {
    error: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
    code: "SERVICE_DAILY_POST_LIMIT",
  };
  const CHECK_FAILED = { error: "We couldn't check today's limits. Try again in a minute.", code: "LIMIT_CHECK_FAILED" };

  it("a draft at the ceiling stays a draft: 429 with the sentence, nothing claimed or prepared", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    reserveSendNowMock.mockResolvedValue({ ok: false, status: 429, body: FULL });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual(FULL);
    expect(reserveSendNowMock).toHaveBeenCalledWith({ workspaceId: "ws-1", postJobIds: ["job-1"], viewerUserId: expect.any(String) });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("the limits cannot be checked (a lock timeout): the draft is unchanged, 503", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    reserveSendNowMock.mockResolvedValue({ ok: false, status: 503, body: CHECK_FAILED });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(CHECK_FAILED);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("reserved, then the claim misses: the reservation is let go and no run is left", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(releaseMock).toHaveBeenCalledWith({ postJobIds: ["job-1"], day: expect.any(Date) });
    expect(prepareDispatchMock).not.toHaveBeenCalled();
  });

  it("reserved and claimed: prepare uses the reservation instead of reserving again", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(202);
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1", { reserved: true });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("prepare throws after the claim: its pending results are failed, the run taken back, 503", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    prepareDispatchMock.mockRejectedValue(new Error("pool timeout"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(503);
    expect(failPendingMock).toHaveBeenCalledWith("job-1", expect.objectContaining({ errorCode: "DISPATCH_FAILED" }));
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts/[postJobId]/publish - a pair, reserved before the claim", () => {
  function storyRow() {
    return {
      id: "story-1",
      storyOfPostJobId: "job-1",
      status: "draft",
      scheduledFor: null,
      createdAt: new Date(),
      updatedAt: new Date("2026-11-01T09:31:00Z"),
      submittedForApprovalAt: null,
      approvedAt: null,
      baseCaption: "Caption",
      perPlatformOverrides: null,
      publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
      coverImageUrl: null,
      mediaItem: null,
    };
  }

  beforeEach(() => {
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  });

  it("a pair at 29: both halves reserved together, refused whole, neither changes", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    reserveSendNowMock.mockResolvedValue({
      ok: false,
      status: 429,
      body: { error: "Vibe Socials has reached its daily limit of posts for the whole service.", code: "SERVICE_DAILY_POST_LIMIT" },
    });

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(reserveSendNowMock).toHaveBeenCalledWith(expect.objectContaining({ postJobIds: ["job-1", "story-1"] }));
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("the claim takes this post but not its other half: the half's run is let go", async () => {
    findFirstMock.mockResolvedValueOnce(jobRow({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await POST(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(releaseMock).toHaveBeenCalledWith({ postJobIds: ["job-1", "story-1"], day: expect.any(Date) }, ["job-1"]);
  });
});
