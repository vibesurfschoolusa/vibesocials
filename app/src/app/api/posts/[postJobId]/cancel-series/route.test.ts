import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, checkRateLimitMock, findFirstMock, findManyMock, updateManyMock } = vi.hoisted(
  () => ({
    getWorkspaceContextMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    findFirstMock: vi.fn(),
    findManyMock: vi.fn(),
    updateManyMock: vi.fn(),
  }),
);

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, findMany: findManyMock, updateMany: updateManyMock },
    // A batch transaction: every update runs, each with its own condition.
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { POST } from "./route";

const ctx = (postJobId: string) => ({ params: Promise.resolve({ postJobId }) });
const req = {} as NextRequest;
const THIS_TIME = new Date("2026-11-19T09:00:00Z");
const SUBMITTED = new Date("2026-11-10T09:00:00Z");

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "scheduled",
    scheduledFor: THIS_TIME,
    seriesId: "series-1",
    submittedForApprovalAt: null,
    approvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  findFirstMock.mockReset();
  findManyMock.mockReset();
  updateManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findFirstMock.mockResolvedValue(row("job-2"));
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe("POST /api/posts/[postJobId]/cancel-series", () => {
  it("401s and touches nothing when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await POST(req, ctx("job-2"));
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("429s when the mutate limit is reached", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const res = await POST(req, ctx("job-2"));
    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ route: "posts/mutate" }));
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("cancels this and the later scheduled posts and drafts of the same series in this workspace", async () => {
    findManyMock.mockResolvedValue([row("job-2"), row("job-3", { status: "draft", scheduledFor: new Date("2026-11-26T09:00:00Z") })]);

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 2, notCancelled: 0 });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "job-2", workspaceId: "ws-1" },
      select: { status: true, scheduledFor: true, seriesId: true },
    });
    // Earlier posts, published ones and one being published do not match.
    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        seriesId: "series-1",
        status: { in: ["scheduled", "draft"] },
        OR: [{ id: "job-2" }, { scheduledFor: { gte: THIS_TIME } }],
      },
      select: { id: true, status: true, submittedForApprovalAt: true, approvedAt: true },
    });
    // The single cancel's conditional update, once per post.
    expect(updateManyMock.mock.calls.map((c) => c[0])).toEqual([
      {
        where: {
          id: "job-2",
          workspaceId: "ws-1",
          status: { in: ["scheduled", "draft"] },
          submittedForApprovalAt: null,
          approvedAt: null,
        },
        data: { status: "cancelled" },
      },
      {
        where: {
          id: "job-3",
          workspaceId: "ws-1",
          status: { in: ["scheduled", "draft"] },
          submittedForApprovalAt: null,
          approvedAt: null,
        },
        data: { status: "cancelled" },
      },
    ]);
  });

  it("a post the scheduler claimed meanwhile is left alone and counted as not cancelled", async () => {
    findManyMock.mockResolvedValue([row("job-2"), row("job-3")]);
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 1, notCancelled: 1 });
  });

  it("409s when nothing could be cancelled", async () => {
    findManyMock.mockResolvedValue([row("job-2")]);
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "NOT_CANCELABLE" });
  });

  it("409s for a post already publishing or published, and cancels nothing", async () => {
    for (const status of ["in_progress", "completed", "cancelled"]) {
      findFirstMock.mockResolvedValue(row("job-2", { status }));
      const res = await POST(req, ctx("job-2"));
      expect(res.status).toBe(409);
    }
    expect(findManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("404s for a post of another workspace, so its series id does nothing", async () => {
    findFirstMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-elsewhere"));

    expect(res.status).toBe(404);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("400s for a post that is not in a series", async () => {
    findFirstMock.mockResolvedValue(row("job-2", { seriesId: null }));

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "This post is not part of a series. Cancel it on its own.",
      code: "NOT_A_SERIES",
    });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("a member may cancel like the single cancel; a pending submission is withdrawn, pinned to its approval facts", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    findFirstMock.mockResolvedValue(row("job-2", { status: "draft" }));
    findManyMock.mockResolvedValue([
      row("job-2", { status: "draft", submittedForApprovalAt: SUBMITTED }),
      row("job-3", { submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    ]);

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    expect(updateManyMock.mock.calls.map((c) => c[0])).toEqual([
      {
        where: {
          id: "job-2",
          workspaceId: "ws-1",
          status: { in: ["scheduled", "draft"] },
          submittedForApprovalAt: SUBMITTED,
          approvedAt: null,
        },
        data: { status: "cancelled", submittedForApprovalAt: null },
      },
      {
        where: {
          id: "job-3",
          workspaceId: "ws-1",
          status: { in: ["scheduled", "draft"] },
          submittedForApprovalAt: SUBMITTED,
          approvedAt: SUBMITTED,
        },
        data: { status: "cancelled" },
      },
    ]);
  });
});
