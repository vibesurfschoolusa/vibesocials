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
  checkDailyPostLimitMock,
  stampJobFindUniqueMock,
  mediaUpdateManyMock,
  transactionMock,
  resultFindFirstMock,
  memberFindUniqueMock,
  reserveSendNowMock,
  releaseMock,
  resultCountMock,
} = vi.hoisted(() => ({
  reserveSendNowMock: vi.fn(),
  releaseMock: vi.fn(),
  resultCountMock: vi.fn(),
  memberFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  resultFindFirstMock: vi.fn(),
  stampJobFindUniqueMock: vi.fn(),
  mediaUpdateManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
  sendEmailMock: vi.fn(),
  failPendingMock: vi.fn(),
  checkDailyPostLimitMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, updateMany: updateManyMock, findUnique: stampJobFindUniqueMock },
    user: { findUnique: userFindUniqueMock },
    workspaceMember: { findUnique: memberFindUniqueMock },
    // Second review, item 1: a reject ends the post through finishPostJob, which
    // stamps its media (read the post's media, then write lastUsedAt).
    mediaItem: { updateMany: mediaUpdateManyMock },
    postJobResult: { findFirst: resultFindFirstMock, count: resultCountMock },
    $transaction: transactionMock,
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
// Keep the REAL DISPATCH_FAILURE constant; only the DB-touching helper is mocked.
vi.mock("@/server/jobs/failPendingResults", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/failPendingResults")>(
    "@/server/jobs/failPendingResults",
  );
  return { ...actual, failPendingPostJobResults: failPendingMock };
});

import { prisma } from "@/lib/db";

import { htmlToPlainText } from "@/server/notifications/plainText";

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
/** R31 pages L2: every request carries the page's workspace id (the context's "ws-1"). */
function withWorkspace(body: unknown): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? { workspaceId: "ws-1", ...body } : body;
}
function req(body: unknown): NextRequest {
  return { json: async () => withWorkspace(body) } as unknown as NextRequest;
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
  vi.unstubAllEnvs();
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
  checkDailyPostLimitMock.mockReset();
  checkDailyPostLimitMock.mockResolvedValue(null);
  reserveSendNowMock.mockReset();
  reserveSendNowMock.mockImplementation(async ({ postJobIds }: { postJobIds: string[] }) => ({
    ok: true,
    reserved: { postJobIds, day: new Date("2026-11-14T15:00:00Z") },
  }));
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);
  stampJobFindUniqueMock.mockReset();

  mediaUpdateManyMock.mockReset();
  stampJobFindUniqueMock.mockResolvedValue({ mediaItemId: "m1", media: [] });
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
  // Verification is only enforced when email can actually be delivered.
  delete process.env.RESEND_API_KEY;

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "owner" }));
  failPendingMock.mockResolvedValue({ failedCount: 1, status: "failed" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  updateManyMock.mockResolvedValue({ count: 1 });
  userFindUniqueMock.mockResolvedValue({ email: "member@example.com" });
  memberFindUniqueMock.mockReset();
  memberFindUniqueMock.mockResolvedValue({ id: "membership-1" });
  inngestSendMock.mockResolvedValue(undefined);
  // sendEmail resolves whether Resend accepted the email (R23-client-journey L4).
  sendEmailMock.mockResolvedValue(true);
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
        // Scheduled again: a new post for the client to look over (client review link).
        clientApprovedAt: null,
        clientChangeRequestedAt: null,
        clientNote: null,
      },
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("publishing now or rejecting leaves the client's marks: the post leaves the client's page", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    await POST(req({ decision: "approve" }), ctx("job-1"));
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    await POST(req({ decision: "reject" }), ctx("job-1"));
    for (const [{ data }] of updateManyMock.mock.calls) {
      expect(data).not.toHaveProperty("clientApprovedAt");
    }
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
        scheduledFor: expect.any(Date),
      },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1", { reserved: true });
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

  // F1 H1: the approval stands; nothing went out because no chosen platform is connected.
  it("approving to publish now with no connected platform answers a plain sentence pointing at Activity", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      code: "NO_CONNECTIONS",
      error:
        "Approved, but nothing was posted: none of this post's platforms is connected. Activity shows what to reconnect.",
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
    // R9-client-journey L3: the decision was recorded, so the submitter is told, with why nothing went out.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("was approved, but nothing was sent");
    expect(sendEmailMock.mock.calls[0][0].html).toContain(
      "Approved, but nothing was sent: none of this post&#39;s platforms is connected. The workspace owner can reconnect them in Settings; Activity shows which.",
    );
  });

  // Review of T1, item 1: the approval stands; the reservation as it went out refused it.
  it("approving to publish now at a daily limit: 429 with the limit's sentence, no event", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    const refusal = {
      errorCode: "OWNER_DAILY_POST_LIMIT",
      errorMessage: "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow.",
    };
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "LIMIT_REACHED", noticeFor: "job-1", refusal });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: `Approved, but not sent. ${refusal.errorMessage}`, code: refusal.errorCode });
    expect(inngestSendMock).not.toHaveBeenCalled();
    // R9-client-journey L3 (lead): no decision email here.
    expect(sendEmailMock).not.toHaveBeenCalled();
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

  // Second review, item 1: a rejected post is cancelled, a final state, so its
  // media counts as used now (retention counts its 30 days from the reject).
  it("rejecting stamps the post's media lastUsedAt to now", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    const before = Date.now();

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["m1"] }, deletedAt: null },
      data: { lastUsedAt: expect.any(Date) },
    });
    const { data } = mediaUpdateManyMock.mock.calls[0][0] as { data: { lastUsedAt: Date } };
    expect(data.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("approving stamps nothing (the post is not finished)", async () => {
    findFirstMock.mockResolvedValue(pendingJob());

    await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("a reject that loses its race stamps nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    updateManyMock.mockResolvedValue({ count: 0 });

    await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
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
    vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: { email: true, timeZone: true },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "member@example.com" });
    expect(sendEmailMock.mock.calls[0][0].html).toContain("/go?w=ws-1&amp;to=%2Factivity");
  });

  // R7-client-journey L1: as postOutcomeEmail, only a submitter who is still
  // a member hears about the decision; a removed one gets no caption or link.
  it("emails nobody when the submitter is no longer a member, and the decision stands", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    memberFindUniqueMock.mockResolvedValue(null);

    for (const decision of ["approve", "reject"]) {
      const res = await POST(req({ decision }), ctx("job-1"));
      expect(res.status).toBe(200);
    }

    expect(memberFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-1", userId: "member-1" } },
      select: { id: true },
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("shows the scheduled time in the member's own zone (F4)", async () => {
    userFindUniqueMock.mockResolvedValue({ email: "member@example.com", timeZone: "Asia/Tokyo" });
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    await POST(req({ decision: "approve" }), ctx("job-1"));

    const expected = FUTURE.toLocaleString("en-US", {
      timeZone: "Asia/Tokyo",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    expect(sendEmailMock.mock.calls[0][0].html).toContain(expected);
  });

  it("still succeeds when the decision email fails", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    sendEmailMock.mockRejectedValue(new Error("smtp down"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
  });
});

// R23-client-journey L4: the Queue says "the author has been notified" only
// when the email went out, so the answer says what happened to it.
describe("POST /api/posts/[postJobId]/approval - whether the author was emailed", () => {
  for (const decision of ["approve", "reject"] as const) {
    it(`${decision}: a member still in the workspace who was emailed -> authorEmail "sent"`, async () => {
      findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

      const res = await POST(req({ decision }), ctx("job-1"));

      expect(res.status).toBe(200);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      await expect(res.json()).resolves.toMatchObject({ authorEmail: "sent" });
    });

    it(`${decision}: a submitter who was removed -> authorEmail "removed", no email`, async () => {
      findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
      memberFindUniqueMock.mockResolvedValue(null);

      const res = await POST(req({ decision }), ctx("job-1"));

      expect(res.status).toBe(200);
      expect(sendEmailMock).not.toHaveBeenCalled();
      await expect(res.json()).resolves.toMatchObject({ authorEmail: "removed" });
    });

    it(`${decision}: an email Resend did not accept -> authorEmail "failed"`, async () => {
      findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
      sendEmailMock.mockResolvedValue(false);

      const res = await POST(req({ decision }), ctx("job-1"));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ authorEmail: "failed" });
    });
  }

  it('a send that throws -> authorEmail "failed", the decision stands', async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    sendEmailMock.mockRejectedValue(new Error("smtp down"));

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "cancelled", authorEmail: "failed" });
  });

  it('a member with no email address on file -> authorEmail "failed"', async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    userFindUniqueMock.mockResolvedValue({ email: null });

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(sendEmailMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ authorEmail: "failed" });
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
      authorEmail: "sent",
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
      authorEmail: "sent",
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
      authorEmail: "sent",
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
      authorEmail: "sent",
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: CLAIM_WHERE,
      data: {
        status: "scheduled",
        approvedAt: expect.any(Date),
        approvedByUserId: "user-1",
        clientApprovedAt: null,
        clientChangeRequestedAt: null,
        clientNote: null,
      },
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
      data: {
        status: "in_progress",
        approvedAt: expect.any(Date),
        approvedByUserId: "user-1",
        scheduledFor: expect.any(Date),
      },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1", { reserved: true });
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
      postJobId: "job-1",
      resultsMarked: true,
    });
    expect(failPendingMock).toHaveBeenCalledWith("job-1", {
      errorCode: "DISPATCH_FAILED",
      errorMessage: "Couldn't start publishing. Please try again.",
    });
    // The member isn't told "publishing now" about a publish that never started;
    // R9-client-journey L3: they are told it was approved and nothing was sent.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const html = sendEmailMock.mock.calls[0][0].html as string;
    expect(html).toContain(
      "Approved, but nothing was sent: publishing couldn&#39;t start. Open the post in Activity and retry it there.",
    );
    expect(html).not.toMatch(/publishing now/i);
    expect(htmlToPlainText(html)).toContain(
      "Approved, but nothing was sent: publishing couldn't start. Open the post in Activity and retry it there.",
    );
    consoleSpy.mockRestore();
  });

  // R26 LL3 item 1: the database blips while Inngest refuses the send. The
  // post exists and may show as publishing, so the answer is the 503 that
  // says so, never a bare 500.
  it("503s with resultsMarked false when the hand-off and the marking both fail", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));
    failPendingMock.mockRejectedValue(new Error("db blip"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
      postJobId: "job-1",
      resultsMarked: false,
    });
    // The submitter still hears once, and (R26 LL3 follow-up) is not told to
    // send again a post that shows as publishing for about two hours.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const html = sendEmailMock.mock.calls[0][0].html as string;
    expect(html).toContain("Approved, but publishing didn&#39;t start as it should, and the post may still go out. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed. Don&#39;t retry it until it shows as failed; then retry it there.");
    expect(html).not.toContain("Open the post in Activity and retry it there.");
    expect(htmlToPlainText(html)).toContain("Approved, but publishing didn't start as it should, and the post may still go out. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed. Don't retry it until it shows as failed; then retry it there.");
    consoleSpy.mockRestore();
  });
});

// R28 publishing L2: the start failed inside prepare, before the post had any
// results. Activity then offers Send again on it, not Retry, so the answer
// says so (withoutResults) and the member's email names Send again.
describe("POST /api/posts/[postJobId]/approval — the start failed before any result", () => {
  beforeEach(() => {
    resultCountMock.mockReset();
    resultCountMock.mockResolvedValue(0);
  });

  it("503 with withoutResults, and the email says to press Send again", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    prepareDispatchMock.mockRejectedValue(new Error("pool timeout"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
      postJobId: "job-1",
      resultsMarked: true,
      withoutResults: true,
    });
    const text = htmlToPlainText(sendEmailMock.mock.calls[0][0].html as string);
    expect(text).toContain(
      "Approved, but nothing was sent: publishing couldn't start. Open the post in Activity and press Send again on it.",
    );
    expect(text).not.toMatch(/retry/i);
    consoleSpy.mockRestore();
  });

  // R29 publishing L1: still in_progress with no results, so the requeue sends it by itself.
  it("not marked either: the email says it is tried again on its own, then what its card says", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    prepareDispatchMock.mockRejectedValue(new Error("pool timeout"));
    failPendingMock.mockRejectedValue(new Error("db blip"));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ resultsMarked: false, withoutResults: true });
    const text = htmlToPlainText(sendEmailMock.mock.calls[0][0].html as string);
    expect(text).toContain(
      "Approved, but publishing didn't start as it should. It will be tried again on its own within about 20 minutes; if that fails too, it shows as failed in Activity, with what to do next on its card.",
    );
    expect(text).not.toMatch(/two hours/);
    expect(text).not.toMatch(/retry/i);
    consoleSpy.mockRestore();
  });
});

describe("POST /api/posts/[postJobId]/approval — daily post limit (usage limits)", () => {
  const NOW_SENTENCE =
    "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.";
  const SCHEDULE_SENTENCE =
    "That day already has 20 posts, which is this workspace's daily limit. Pick another day.";

  it("approving into a still-future slot checks that day", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      day: FUTURE,
      mode: "schedule",
      excludePostJobId: "job-1",
      viewerUserId: expect.any(String),
    });
  });

  it("approving into a full day answers 429 with the sentence and code, and decides nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));
    checkDailyPostLimitMock.mockResolvedValue({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("approving to publish now checks today", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: PAST }));
    const before = Date.now();

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    const args = checkDailyPostLimitMock.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: "ws-1", mode: "now", excludePostJobId: "job-1" });
    expect(args.day.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("approving to publish now at the limit answers 429 and dispatches nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob());
    checkDailyPostLimitMock.mockResolvedValue({ error: NOW_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: NOW_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("rejecting is never checked", async () => {
    findFirstMock.mockResolvedValue(pendingJob());

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts/[postJobId]/approval — approving to publish now counts toward today (usage limits)", () => {
  it("an old held draft approved to publish now is stamped with the time it goes out, the instant the limit was checked for", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    const before = Date.now();

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(200);
    const data = updateManyMock.mock.calls[0][0].data as { status: string; scheduledFor?: unknown };
    expect(data.status).toBe("in_progress");
    expect(data.scheduledFor).toBeInstanceOf(Date);
    expect((data.scheduledFor as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(checkDailyPostLimitMock.mock.calls[0][0].day).toEqual(data.scheduledFor);
  });

  it("a slot that passed during review is replaced by now", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: PAST }));

    await POST(req({ decision: "approve" }), ctx("job-1"));

    const data = updateManyMock.mock.calls[0][0].data as { scheduledFor?: Date };
    expect(data.scheduledFor!.getTime()).toBeGreaterThan(PAST.getTime());
  });

  it("an old held draft approved to publish now is refused at today's limit", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    checkDailyPostLimitMock.mockResolvedValue({
      error:
        "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.",
      code: "WORKSPACE_DAILY_POST_LIMIT",
    });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(checkDailyPostLimitMock.mock.calls[0][0]).toMatchObject({ mode: "now" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("approving into a kept future slot does not touch scheduledFor", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: FUTURE }));

    await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(updateManyMock.mock.calls[0][0].data).not.toHaveProperty("scheduledFor");
  });
});

// R2-client-journey M1: a held Feed and Story post is two jobs; rejecting one rejects both.
// R3-client-journey M1: a held Feed and Story post is one Queue card. With
// includePair a decision takes both halves in one transaction (pairRule.ts),
// and the member gets one email that names the Story.
describe("POST /api/posts/[postJobId]/approval - a Feed and Story card", () => {
  const STORY_REVIEWED = new Date("2026-07-26T09:31:00Z");
  function storyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "story-1",
      storyOfPostJobId: "job-1",
      status: "draft",
      scheduledFor: null,
      createdAt: SUBMITTED,
      updatedAt: STORY_REVIEWED,
      submittedForApprovalAt: SUBMITTED,
      approvedAt: null,
      baseCaption: "Member's post",
      perPlatformOverrides: null,
      publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
      coverImageUrl: null,
      mediaItem: null,
      ...overrides,
    };
  }
  const STORY_CLAIM_WHERE = { ...CLAIM_WHERE, id: "story-1", updatedAt: STORY_REVIEWED };

  beforeEach(() => {
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  });

  it("rejecting rejects both halves once each, in one transaction, each pinned to its own version", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    const res = await POST(req({ decision: "reject", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      decision: "reject",
      status: "cancelled",
      approvalState: "rejected",
      scheduledFor: null,
      authorEmail: "sent",
      // Old tabs (R2) read this flag; the Queue reads otherHalf.
      pairRejected: true,
      otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was rejected too." },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { storyOfPostJobId: "job-1", workspaceId: "ws-1" } }),
    );
    expect(updateManyMock.mock.calls).toEqual([
      [{ where: CLAIM_WHERE, data: { status: "cancelled" } }],
      [{ where: STORY_CLAIM_WHERE, data: { status: "cancelled" } }],
    ]);
  });

  it("rejecting: the member gets ONE email, which says the Story will not be published either", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    await POST(req({ decision: "reject", includePair: true }), ctx("job-1"));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].html).toContain("Its Story on Instagram will not be published either.");
  });

  it("approving a kept slot approves both halves and the member gets ONE email naming the Story", async () => {
    findFirstMock
      .mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null, scheduledFor: FUTURE }))
      .mockResolvedValueOnce(storyRow({ scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: true,
      note: "Its Story was approved too.",
    });
    const approved = {
      status: "scheduled",
      approvedAt: expect.any(Date),
      approvedByUserId: "user-1",
      clientApprovedAt: null,
      clientChangeRequestedAt: null,
      clientNote: null,
    };
    expect(updateManyMock.mock.calls).toEqual([
      [{ where: CLAIM_WHERE, data: approved }],
      [{ where: STORY_CLAIM_WHERE, data: approved }],
    ]);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].html).toContain("Its Story on Instagram was approved too.");
  });

  it("approving to publish now sends both publish events in one send, each post claimed once", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) => ({
      ok: true,
      event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
    }));

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(prepareDispatchMock.mock.calls).toEqual([["job-1", { reserved: true }], ["story-1", { reserved: true }]]);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: "publish-job-1" }),
      expect.objectContaining({ id: "publish-story-1" }),
    ]);
  });

  // Review of R3: one half had nothing it could send but the other went out.
  it("approved to publish now, the feed post has nothing sendable but its Story is sent: success, saying so", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) =>
      id === "job-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
    );
    resultFindFirstMock.mockResolvedValue({ errorMessage: "Reconnect Facebook Page in Settings." });

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(
      "Approved. The Story is being sent. The feed post was not: Reconnect Facebook Page in Settings.",
    );
    expect(inngestSendMock).toHaveBeenCalledWith(expect.objectContaining({ id: "publish-story-1" }));
  });

  it("a pair approved to publish now counts as two posts today, neither against itself", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ excludePostJobId: ["job-1", "story-1"], alsoOnDay: 1 }),
    );
  });

  it("rejecting the Story rejects its held feed post", async () => {
    findFirstMock
      .mockResolvedValueOnce(pendingJob({ storyOfPostJobId: "feed-1" }))
      .mockResolvedValueOnce(storyRow({ id: "feed-1", storyOfPostJobId: null }));

    const res = await POST(req({ decision: "reject", includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "feed-1",
      kind: "feed",
      changed: true,
      note: "Its feed post was rejected too.",
    });
    expect(findFirstMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "feed-1", workspaceId: "ws-1" } }),
    );
  });

  it("an other half that is not held (already decided) is left alone and named", async () => {
    findFirstMock
      .mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null }))
      .mockResolvedValueOnce(storyRow({ status: "scheduled", approvedAt: SUBMITTED }));

    const res = await POST(req({ decision: "reject", includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story is not waiting for approval, so it was not rejected.",
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    // Nothing happened to the Story, so the email does not name it.
    expect(sendEmailMock.mock.calls[0][0].html).not.toContain("Its Story");
  });

  // R29 publishing L2: approved to publish now; the feed post got its results,
  // the Story's prepare threw, so the Story has none and offers Send again only.
  it("a failed start: the answer and the member's email tell the Story to press Send again", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("pool timeout");
      return {
        ok: true,
        event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
      };
    });
    resultCountMock.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
      postJobId: "job-1",
      resultsMarked: true,
      otherHalf: {
        id: "story-1",
        kind: "story",
        changed: true,
        note: "Its Story was not sent: press Send again on its card in Activity.",
      },
    });
    const text = htmlToPlainText(sendEmailMock.mock.calls[0][0].html as string);
    expect(text).toContain("Approved, but nothing was sent: publishing couldn't start. Open the post in Activity and retry it there.");
    expect(text).toContain("Its Story was not sent: press Send again on its card in Activity.");
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/but nothing was sent$/);
  });

  // Review of R29 L2: the Story's marking threw, so its results may still be
  // pending and it may go out; the email's subject must not say nothing was sent.
  it("a failed start whose Story couldn't be marked: it may have started, and the subject says so", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) => ({
      ok: true,
      event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
    }));
    inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));
    failPendingMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("db blip");
      return { failedCount: 1, unconfirmedCount: 0, status: "failed" };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.resultsMarked).toBe(true);
    expect(body.otherHalf.note).toBe("Its Story may not have started: check its card in Activity; it can show as publishing for about two hours, sometimes a little longer, before it shows what to do next.");
    const email = sendEmailMock.mock.calls[0][0];
    expect(htmlToPlainText(email.html as string)).toContain("Its Story may not have started: check its card in Activity; it can show as publishing for about two hours, sometimes a little longer, before it shows what to do next.");
    expect(email.subject).not.toMatch(/nothing was sent/);
    expect(email.subject).toMatch(/but publishing may not have started$/);
  });

  it("without includePair an approval takes this post alone, exactly as for any post", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null, scheduledFor: FUTURE }));

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(Object.keys(await res.json())).not.toContain("otherHalf");
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // Review of R3: a tab still running the old Queue sends no includePair. Its
  // reject keeps R2's behaviour: the held other half is rejected too.
  it("a reject without includePair (an old tab) rejects both held halves, as before", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect((await res.json()).pairRejected).toBe(true);
    expect(updateManyMock.mock.calls).toEqual([
      [{ where: CLAIM_WHERE, data: { status: "cancelled" } }],
      [{ where: STORY_CLAIM_WHERE, data: { status: "cancelled" } }],
    ]);
  });

  // R4 lows, item 4: an old tab's reject asked about no other half, so the
  // answer names one only when it was rejected too.
  it("a reject without includePair whose other half is cancelled, or not held, says nothing about it", async () => {
    for (const other of [storyRow({ status: "cancelled" }), storyRow({ status: "scheduled", approvedAt: SUBMITTED })]) {
      findFirstMock.mockReset();
      updateManyMock.mockClear();
      findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(other);

      const res = await POST(req({ decision: "reject" }), ctx("job-1"));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.otherHalf, other.status).toBeUndefined();
      expect(body.pairRejected, other.status).toBeUndefined();
      expect(updateManyMock, other.status).toHaveBeenCalledTimes(1);
    }
  });

  it("a reject with includePair still names a cancelled other half it left alone", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow({ status: "cancelled" }));

    const res = await POST(req({ decision: "reject", includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual(expect.objectContaining({ changed: false }));
  });

  // R4 lows, item 3: the member's email describes the feed post and names the
  // Story, whichever half the owner decided from.
  it("deciding from the Story: the member's email shows the feed post's caption and names the Story", async () => {
    for (const decision of ["approve", "reject"] as const) {
      findFirstMock.mockReset();
      sendEmailMock.mockClear();
      findFirstMock
        .mockResolvedValueOnce(
          pendingJob({
            storyOfPostJobId: "feed-1",
            scheduledFor: FUTURE,
            baseCaption: "Story's own copy",
            publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
          }),
        )
        .mockResolvedValueOnce(
          storyRow({
            id: "feed-1",
            storyOfPostJobId: null,
            scheduledFor: FUTURE,
            baseCaption: "Feed caption",
            publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
          }),
        );

      await POST(req({ decision, includePair: true }), ctx("job-1"));

      expect(sendEmailMock, decision).toHaveBeenCalledTimes(1);
      const html = sendEmailMock.mock.calls[0][0].html as string;
      expect(html, decision).toContain("Feed caption");
      expect(html, decision).not.toContain("Story's own copy");
      expect(html, decision).toContain(decision === "approve" ? "Its Story on Instagram was approved too." : "Its Story on Instagram will not be published either.");
    }
  });

  // R4 lows, item 5: a failed send is "try again", even when this post had nothing sendable.
  it("approved to publish now, this post had nothing sendable, its Story was prepared and the send failed: 503 try again", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(storyRow());
    prepareDispatchMock.mockImplementation(async (id: string) =>
      id === "job-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "member-1", workspaceId: "ws-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null } },
    );
    inngestSendMock.mockRejectedValue(new Error("inngest down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ decision: "approve", includePair: true }), ctx("job-1"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("DISPATCH_FAILED");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].html).toContain("Approved, but nothing was sent: publishing couldn&#39;t start.");
    consoleSpy.mockRestore();
  });

  it("a reject without includePair of a post that is not a pair: one write, no pairRejected", async () => {
    findFirstMock.mockResolvedValueOnce(pendingJob({ storyOfPostJobId: null })).mockResolvedValueOnce(null);

    const res = await POST(req({ decision: "reject" }), ctx("job-1"));

    const body = await res.json();
    expect(body.pairRejected).toBeUndefined();
    expect(body.otherHalf).toBeUndefined();
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// Second look at T1, item 1: approving to publish now reserves before the decision is written.
describe("POST /api/posts/[postJobId]/approval - reserved before the claim", () => {
  const FULL = {
    error: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
    code: "SERVICE_DAILY_POST_LIMIT",
  };

  it("pending approval at the ceiling: it stays pending, the approver reads the sentence, the submitter hears nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    reserveSendNowMock.mockResolvedValue({ ok: false, status: 429, body: FULL });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual(FULL);
    expect(reserveSendNowMock).toHaveBeenCalledWith({ workspaceId: "ws-1", postJobIds: ["job-1"], viewerUserId: "user-1" });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prepareDispatchMock).not.toHaveBeenCalled();
  });

  it("the limits cannot be checked: nothing decided, 503 with the try-again sentence", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    const failed = { error: "We couldn't check today's limits. Try again in a minute.", code: "LIMIT_CHECK_FAILED" };
    reserveSendNowMock.mockResolvedValue({ ok: false, status: 503, body: failed });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(failed);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("reserved, then the decision write misses: the reservation is let go", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ decision: "approve" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(releaseMock).toHaveBeenCalledWith({ postJobIds: ["job-1"], day: expect.any(Date) });
  });

  it("approving for a later time or rejecting reserves nothing", async () => {
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: new Date(Date.now() + 86_400_000) }));
    await POST(req({ decision: "approve" }), ctx("job-1"));
    findFirstMock.mockResolvedValue(pendingJob({ scheduledFor: null }));
    await POST(req({ decision: "reject" }), ctx("job-1"));
    expect(reserveSendNowMock).not.toHaveBeenCalled();
  });
});

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
describe("POST /api/posts/[postJobId]/approval: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no post is read", async () => {
    const res = await POST({ json: async () => ({ decision: "approve", reviewedUpdatedAt: new Date().toISOString() }) } as unknown as NextRequest, ctx("job-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no post is read", async () => {
    const res = await POST(req({ decision: "approve", reviewedUpdatedAt: new Date().toISOString(), workspaceId: "ws-2" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
