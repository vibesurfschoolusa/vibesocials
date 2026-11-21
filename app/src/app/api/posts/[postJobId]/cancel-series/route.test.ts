import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

const {
  getWorkspaceContextMock,
  checkRateLimitMock,
  findFirstMock,
  findManyMock,
  updateManyMock,
  findUniqueMock,
  mediaUpdateManyMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  mediaUpdateManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => {
  const client = {
    postJob: { findFirst: findFirstMock, findMany: findManyMock, updateMany: updateManyMock, findUnique: findUniqueMock },
    // Review round 3: each cancel goes through finishPostJob, which stamps the
    // post's media (read its media, then write lastUsedAt).
    mediaItem: { updateMany: mediaUpdateManyMock },
  };
  // One transaction: the callback gets the same client, each update with its own condition.
  return { prisma: { ...client, $transaction: (fn: (tx: typeof client) => unknown) => fn(client) } };
});

import { POST } from "./route";

const ctx = (postJobId: string) => ({ params: Promise.resolve({ postJobId }) });
/** R31 pages L2: every request carries the page's workspace id (the context's "ws-1"). */
const req = { json: async () => ({ workspaceId: "ws-1" }) } as unknown as NextRequest;
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
  findUniqueMock.mockReset();
  mediaUpdateManyMock.mockReset();
  findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    mediaItemId: `media-${where.id}`,
    media: [],
  }));
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
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
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 2, notCancelled: 0, changed: 0 });
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
    findManyMock
      .mockResolvedValueOnce([row("job-2"), row("job-3")])
      .mockResolvedValueOnce([{ id: "job-3", status: "in_progress" }]);
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 1, notCancelled: 1, changed: 0 });
  });

  // R59 publishing-flow L4: the writes are pinned to the approval fields, so a
  // post a member's edit sent back for approval meanwhile is missed while it is
  // still cancellable. It is counted apart, so the toast doesn't say it started publishing.
  it("some cancelled, some changed, some moved on: notCancelled counts only those that moved on", async () => {
    findManyMock
      .mockResolvedValueOnce([row("job-2"), row("job-3"), row("job-4"), row("job-5")])
      .mockResolvedValueOnce([
        { id: "job-3", status: "draft" },
        { id: "job-4", status: "in_progress" },
      ]);
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    // job-5 is gone: it moved on too.
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 1, notCancelled: 2, changed: 1 });
    expect(findManyMock).toHaveBeenLastCalledWith({
      where: { id: { in: ["job-3", "job-4", "job-5"] }, workspaceId: "ws-1" },
      select: { id: true, status: true },
    });
  });

  // Fix review of R59: the cancel has committed, so a failed count must not turn it into a 500.
  it("the changed count can't be read after a cancel that worked: 200 with the old counts", async () => {
    findManyMock.mockResolvedValueOnce([row("job-2"), row("job-3")]).mockRejectedValueOnce(new Error("db blip"));
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: 1, notCancelled: 1, changed: 0 });
    errors.mockRestore();
  });

  it("every post missed while this one is still cancellable: 409, changed in the meantime", async () => {
    findFirstMock.mockResolvedValueOnce(row("job-2")).mockResolvedValueOnce({ status: "draft" });
    findManyMock.mockResolvedValue([row("job-2"), row("job-3")]);
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "This post changed in the meantime. Try again.", code: "POST_CHANGED" });
  });

  // Review round 3: like the single cancel, through finishPostJob, so the
  // retention sweep counts each post's media from the cancel.
  it("stamps the media of each post it cancels, and not of one that lost its race", async () => {
    findManyMock.mockResolvedValue([row("job-2"), row("job-3")]);
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await POST(req, ctx("job-2"));

    expect(res.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["media-job-2"] }, deletedAt: null },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("409s when nothing could be cancelled", async () => {
    findFirstMock.mockResolvedValueOnce(row("job-2")).mockResolvedValueOnce({ status: "in_progress" });
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

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
describe("POST /api/posts/[postJobId]/cancel-series: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no post is read", async () => {
    const res = await POST({ json: async () => ({}) } as unknown as NextRequest, ctx("job-2"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no post is read", async () => {
    const res = await POST({ json: async () => ({ workspaceId: "ws-2" }) } as unknown as NextRequest, ctx("job-2"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});

// R31 publishing L1: "this and all later posts" on a post that moved on said
// "Only scheduled or draft posts can be cancelled." and nothing about the
// later posts. It now says what happened and that the later posts were left.
describe("POST /api/posts/[postJobId]/cancel-series: a post that moved on", () => {
  it.each([
    ["in_progress", "This post has started publishing, so it can't be cancelled. Check Activity to see how it goes."],
    ["completed", "This post has already gone out, so it can't be cancelled. Check Activity to see it."],
    ["failed", "This post failed, so it can't be cancelled. Check Activity for what to do next."],
    ["cancelled", "This post was already cancelled."],
  ])("%s: the sentence, and the later posts are said to be left as they are", async (status, said) => {
    findFirstMock.mockResolvedValue(row("job-2", { status }));
    const res = await POST(req, ctx("job-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: `${said} The later posts in this series were left as they are: cancel them on their own cards.`,
      code: "NOT_CANCELABLE",
    });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("lost the race for every post: the post's state read again, and the same sentence", async () => {
    findFirstMock.mockResolvedValueOnce(row("job-2")).mockResolvedValueOnce({ status: "in_progress" });
    findManyMock.mockResolvedValue([row("job-2")]);
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await POST(req, ctx("job-2"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This post has started publishing, so it can't be cancelled. Check Activity to see how it goes. The later posts in this series were left as they are: cancel them on their own cards.",
    );
  });

  it("deleted: 404 with the sentence, never a bare Not found", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await POST(req, ctx("job-2"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "This post no longer exists." });
  });
});
