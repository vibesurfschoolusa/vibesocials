import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  connectionCountMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
  notifyOwnersMock: vi.fn(),
  failPendingMock: vi.fn(),
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, updateMany: updateManyMock },
    socialConnection: { count: connectionCountMock },
  },
}));
vi.mock("@/server/jobs/posting", () => ({
  prepareDeferredPostJobDispatch: prepareDispatchMock,
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

import { POST } from "./route";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const SUBMITTED = new Date("2026-11-01T09:00:00Z");
const UPDATED = new Date("2026-11-01T09:30:00Z");

/** The ownership/approval read's row; defaults to a plain draft. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "draft",
    scheduledFor: null,
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

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  notifyOwnersMock.mockResolvedValue(undefined);
  failPendingMock.mockResolvedValue({ failedCount: 2, status: "failed" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  updateManyMock.mockResolvedValue({ count: 1 });
  connectionCountMock.mockResolvedValue(2);
  inngestSendMock.mockResolvedValue(undefined);
  prepareDispatchMock.mockResolvedValue({
    ok: true,
    event: { postJobId: "job-1", userId: "user-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
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
        submittedForApprovalAt: true,
        approvedAt: true,
        baseCaption: true,
        updatedAt: true,
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
      data: { status: "scheduled", scheduledFor: new Date(FUTURE) },
    });
    // Scheduling sends no event now — the cron dispatches when due.
    expect(inngestSendMock).not.toHaveBeenCalled();
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
      data: { status: "in_progress" },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1");
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/publish.requested",
      data: expect.objectContaining({ postJobId: "job-1" }),
    });
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

  it("409s when a connection vanished between the count and prepare (prepare NO_CONNECTIONS)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
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
    });
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
