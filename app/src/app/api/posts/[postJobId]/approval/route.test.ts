import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
  sendEmailMock: vi.fn(),
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
vi.mock("@/server/jobs/posting", () => ({
  prepareDeferredPostJobDispatch: prepareDispatchMock,
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import { POST } from "./route";

const SUBMITTED = new Date("2026-07-26T09:00:00Z");
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
    ...overrides,
  };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  userFindUniqueMock.mockReset();
  inngestSendMock.mockReset();
  prepareDispatchMock.mockReset();
  sendEmailMock.mockReset();

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "owner" }));
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
      where: { id: "job-1", workspaceId: "ws-1", status: "draft" },
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
      where: { id: "job-1", workspaceId: "ws-1", status: "draft" },
      data: {
        status: "in_progress",
        approvedAt: expect.any(Date),
        approvedByUserId: "user-1",
      },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
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
      where: { id: "job-1", workspaceId: "ws-1", status: "draft" },
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
