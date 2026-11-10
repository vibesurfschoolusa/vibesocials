import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports workspace, db, inngest,
// rateLimit, posting and the notifications transport at module scope;
// `@/lib/approval` and `@/lib/scheduling` stay REAL (pure rules the handler
// relies on).
const {
  getWorkspaceContextMock,
  checkRateLimitMock,
  findFirstMock,
  updateManyMock,
  userFindUniqueMock,
  inngestSendMock,
  prepareDispatchMock,
  sendEmailMock,
  failPendingMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
  sendEmailMock: vi.fn(),
  failPendingMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, updateMany: updateManyMock },
    user: { findUnique: userFindUniqueMock },
  },
}));
// Keep the REAL event builder (buildPublishEvent); only the DB-touching dispatch
// preparation is mocked.
vi.mock("@/server/jobs/posting", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/posting")>(
    "@/server/jobs/posting",
  );
  return { ...actual, prepareDeferredPostJobDispatch: prepareDispatchMock };
});
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
// Keep the REAL DISPATCH_FAILURE constant; only the DB-touching helper is mocked.
vi.mock("@/server/jobs/failPendingResults", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/failPendingResults")>(
    "@/server/jobs/failPendingResults",
  );
  return { ...actual, failPendingPostJobResults: failPendingMock };
});

import { POST } from "./route";

const SUBMITTED = new Date("2026-07-26T09:00:00Z");
/** The version of the post the owner reviewed (PostJob.updatedAt). */
const REVIEWED = new Date("2026-07-26T09:30:00.250Z");
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function ctx(postJobId: string) {
  // Next 16 passes params as a promise — see the PR #41 lesson.
  return { params: Promise.resolve({ postJobId }) };
}
function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** A pending submission: submitted, undecided, still a draft. */
function pendingJob(overrides: Record<string, unknown> = {}) {
  return {
    status: "draft",
    scheduledFor: null,
    submittedForApprovalAt: SUBMITTED,
    approvedAt: null,
    userId: "member-1",
    baseCaption: "Member's post",
    updatedAt: REVIEWED,
    ...overrides,
  };
}

/**
 * The decision claim: a still-undecided submission — a held draft or (ruling
 * R10 backstop) a scheduled row left submitted-but-unapproved — at exactly the
 * version that was read.
 */
const CLAIM_WHERE = {
  id: "job-1",
  workspaceId: "ws-1",
  status: { in: ["draft", "scheduled"] },
  submittedForApprovalAt: { not: null },
  approvedAt: null,
  updatedAt: REVIEWED,
};

const ORIGINAL_RESEND_API_KEY = process.env.RESEND_API_KEY;
afterEach(() => {
  if (ORIGINAL_RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
});

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  userFindUniqueMock.mockReset();
  inngestSendMock.mockReset();
  prepareDispatchMock.mockReset();
  sendEmailMock.mockReset();
  failPendingMock.mockReset();
  // Verification is only enforced when email can actually be delivered.
  delete process.env.RESEND_API_KEY;

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "owner" }));
  failPendingMock.mockResolvedValue({ failedCount: 1, status: "failed" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  updateManyMock.mockResolvedValue({ count: 1 });
  userFindUniqueMock.mockResolvedValue({ email: "member@example.com" });
  inngestSendMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue(undefined);
  prepareDispatchMock.mockResolvedValue({
    ok: true,
    event: {
      postJobId: "job-1",
      userId: "member-1",
      // prepareDeferredPostJobDispatch reads it off the job row (the route has
      // already scoped that job to the caller's workspace).
      workspaceId: "ws-1",
      mediaItemId: "m1",
      baseCaption: "c",
      perPlatformOverrides: null,
    },
  });
});

describe("POST /api/posts/[postJobId]/approval", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("403s a MEMBER and writes nothing — only owners decide", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
    findFirstMock.mockResolvedValue(pendingJob());

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(403);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("400s an unknown decision", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    const res = await POST(req({ decision: "maybe" }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("404s a job outside the caller's workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await POST(req({ decision: "approve" }), ctx("foreign"));
    expect(res.status).toBe(404);
  });

  it("409s a job that isn't awaiting approval", async () => {
    findFirstMock.mockResolvedValue(
      pendingJob({ submittedForApprovalAt: null }), // never submitted
    );
    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("409s a submission that was already approved (no re-deciding)", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ approvedAt: SUBMITTED }));
    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("approving a post whose time is still ahead schedules it, without publishing", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("scheduled");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: {
        status: "scheduled",
        approvedAt: expect.any(Date),
        approvedByUserId: "user-1",
      },
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("approving a post with no time publishes it now", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("in_progress");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: {
        status: "in_progress",
        approvedAt: expect.any(Date),
        approvedByUserId: "user-1",
      },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    // 2026-11-01 scale audit (jobs H6 + H1): stable event id, the workspace for
    // the shared concurrency key, and the Post-now priority flag.
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-1",
        userId: "member-1",
        workspaceId: "ws-1",
        immediate: true,
      }),
    });
  });

  it("publishes now when the chosen time passed while awaiting approval", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: PAST }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(body.status).toBe("in_progress");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("409s when the atomic claim loses a race (count 0) and publishes nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("rejecting cancels the post, leaves approvedAt null, and publishes nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("cancelled");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: { status: "cancelled" },
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("emails the submitting member about the decision", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: { email: true },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "member@example.com" });
  });

  it("still succeeds when the decision email fails", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    sendEmailMock.mockRejectedValue(new Error("smtp down"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/posts/[postJobId]/approval — response contract (2026-11-01 audit)", () => {
  it("approve + time ahead → scheduled, approved, keeps the time", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      decision: "approve",
      status: "scheduled",
      approvalState: "approved",
      scheduledFor: FUTURE.toISOString(),
    });
  });

  it("approve + passed time → in_progress, approved, no scheduled time", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: PAST }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      decision: "approve",
      status: "in_progress",
      approvalState: "approved",
      scheduledFor: null,
    });
  });

  it("reject → cancelled, rejected, no scheduled time", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      decision: "reject",
      status: "cancelled",
      approvalState: "rejected",
      scheduledFor: null,
    });
  });
});

describe("POST /api/posts/[postJobId]/approval — CHANGED_SINCE_REVIEW (2026-11-01 audit)", () => {
  it("409s without deciding when the post changed after the owner opened it", async () => {
    findFirstMock.mockResolvedValue(pendingJob());

    const res = await POST(
      req({ decision: "approve", reviewedUpdatedAt: "2026-07-26T09:00:00.000Z" }),
      ctx("job-1"),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      code: "CHANGED_SINCE_REVIEW",
      error: "This post changed since you opened it. Review the latest version.",
    });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses a stale REJECT too", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    const res = await POST(
      req({ decision: "reject", reviewedUpdatedAt: "2026-07-26T09:00:00.000Z" }),
      ctx("job-1"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CHANGED_SINCE_REVIEW");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("decides when the reviewed version is the current one", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(
      req({ decision: "approve", reviewedUpdatedAt: REVIEWED.toISOString() }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("400s a reviewedUpdatedAt that isn't a string", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    const res = await POST(req({ decision: "approve", reviewedUpdatedAt: 12345 }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("the decision write is pinned to the read updatedAt; losing it to a concurrent EDIT → CHANGED_SINCE_REVIEW", async () => {
    // First read: the version being decided. Re-read after the lost write: an
    // edit bumped updatedAt but the post is still a held draft.
    findFirstMock
      .mockResolvedValueOnce(pendingJob())
      .mockResolvedValueOnce(pendingJob({ updatedAt: new Date("2026-07-26T09:45:00Z") }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CHANGED_SINCE_REVIEW");
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: CLAIM_WHERE,
      }),
    );
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("losing the write to a concurrent DECISION → NOT_PENDING_APPROVAL", async () => {
    findFirstMock
      .mockResolvedValueOnce(pendingJob())
      .mockResolvedValueOnce(pendingJob({ status: "cancelled" }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PENDING_APPROVAL");
  });
});

// Ruling R10 backstop (final review M1): the pre-fix publish route could leave
// a post `scheduled` + submitted + unapproved. The cron never claims such a row
// (R6) and the decision claim used to require `status: "draft"`, so Approve /
// Reject 409'd and the post was stuck forever. Such a row is now decidable.
describe("POST /api/posts/[postJobId]/approval — a scheduled row still awaiting a decision (ruling R10)", () => {
  const stuck = (overrides: Record<string, unknown> = {}) =>
    pendingJob({ status: "scheduled", scheduledFor: FUTURE, ...overrides });

  it("approve, time still ahead → stays scheduled at its time, now approved (the cron can claim it)", async () => {
    findFirstMock.mockResolvedValue(stuck());

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      decision: "approve",
      status: "scheduled",
      approvalState: "approved",
      scheduledFor: FUTURE.toISOString(),
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: { status: "scheduled", approvedAt: expect.any(Date), approvedByUserId: "user-1" },
    });
    expect(prepareDispatchMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("approve, time already passed → publishes now", async () => {
    findFirstMock.mockResolvedValue(stuck({ scheduledFor: PAST }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "in_progress", approvalState: "approved" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: { status: "in_progress", approvedAt: expect.any(Date), approvedByUserId: "user-1" },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("reject → cancelled (reads back rejected), nothing published", async () => {
    findFirstMock.mockResolvedValue(stuck());

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "cancelled", approvalState: "rejected" });
    expect(updateManyMock).toHaveBeenCalledWith({ where: CLAIM_WHERE, data: { status: "cancelled" } });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("losing the write to a concurrent edit of the still-undecided row → CHANGED_SINCE_REVIEW", async () => {
    findFirstMock
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck({ updatedAt: new Date("2026-07-26T09:45:00Z") }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CHANGED_SINCE_REVIEW");
  });

  it.each(["in_progress", "completed", "failed"])(
    "a submitted-but-unapproved row that is already %s is not decidable (409, no write)",
    async (status) => {
      findFirstMock.mockResolvedValue(pendingJob({ status }));

      const res = await POST(req({ decision: "approve" }), ctx("job-1"));

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("NOT_PENDING_APPROVAL");
      expect(updateManyMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
    },
  );
});

// 2026-11-09: publishing no longer waits for a verified email. Posting needs
// the person's own platform accounts connected through each platform's sign-in,
// and Meta's reviewers register with any email address, then publish.
describe("POST /api/posts/[postJobId]/approval — an unverified email may publish", () => {
  beforeEach(() => {
    // Email is deliverable, and the owner (fixture) has no emailVerifiedAt.
    process.env.RESEND_API_KEY = "re_test";
  });

  it("lets an owner who hasn't verified their email approve-and-publish", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't gate an approval that only schedules (nothing goes out yet)", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    const res = await POST(req({ decision: "approve" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it("doesn't gate a rejection", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    const res = await POST(req({ decision: "reject" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/posts/[postJobId]/approval — dispatch failure (2026-11-01 audit)", () => {
  it("503s DISPATCH_FAILED and fails the pending results when inngest.send throws on approve-and-publish", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
    });
    expect(failPendingMock).toHaveBeenCalledWith("job-1", {
      errorCode: "DISPATCH_FAILED",
      errorMessage: "Couldn't start publishing. Please try again.",
    });
    // The member isn't told "publishing now" about a publish that never started.
    expect(sendEmailMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
