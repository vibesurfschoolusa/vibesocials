import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace` and
// `@/lib/db` at module scope, so both are mocked before the import below.
const { getWorkspaceContextMock, updateManyMock, findFirstMock, findUniqueMock, mediaUpdateManyMock, checkRateLimitMock, transactionMock } = vi.hoisted(
  () => ({
    transactionMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    getWorkspaceContextMock: vi.fn(),
    updateManyMock: vi.fn(),
    findFirstMock: vi.fn(),
    findUniqueMock: vi.fn(),
    mediaUpdateManyMock: vi.fn(),
  }),
);

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { updateMany: updateManyMock, findFirst: findFirstMock, findUnique: findUniqueMock },
    // Review round 2, item 6: the cancel ends the post through finishPostJob,
    // which stamps the media's last use (read the post's media, then write).
    mediaItem: { updateMany: mediaUpdateManyMock },
    $transaction: transactionMock,
  },
}));

import { prisma } from "@/lib/db";

import { POST } from "./route";

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}
const req = {} as NextRequest;

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  updateManyMock.mockReset();
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
  mediaUpdateManyMock.mockReset();
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  findUniqueMock.mockResolvedValue({ mediaItemId: "media-1", media: [] });
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
});

/** The ownership/approval read's row; defaults to a plain scheduled post. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return { status: "scheduled", submittedForApprovalAt: null, approvedAt: null, ...overrides };
}

const SUBMITTED = new Date("2026-11-01T09:00:00Z");

describe("POST /api/posts/[postJobId]/cancel", () => {
  beforeEach(() => {
    findFirstMock.mockResolvedValue(jobRow());
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("stamps the post's media as used now when it cancels (retention counts from here)", async () => {
    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["media-1"] }, deletedAt: null },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("stamps nothing when the cancel loses its race", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(409);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("401s and never touches the DB when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cancels a scheduled/draft job via an atomic workspace+status-scoped update pinned to the approval facts it read", async () => {
    const res = await POST(req, ctx("job-1"));
    const body = (await res.json()) as { ok?: boolean; status?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "cancelled" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
        submittedForApprovalAt: null,
        approvedAt: null,
      },
      data: { status: "cancelled" },
    });
  });

  it("withdrawing a PENDING post clears submittedForApprovalAt in the same update (reads 'none', not 'rejected')", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "draft", submittedForApprovalAt: SUBMITTED }));

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
        submittedForApprovalAt: SUBMITTED,
        approvedAt: null,
      },
      data: { status: "cancelled", submittedForApprovalAt: null },
    });
  });

  it("cancelling an APPROVED scheduled post keeps its approval record", async () => {
    findFirstMock.mockResolvedValue(
      jobRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    await POST(req, ctx("job-1"));

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "cancelled" } }),
    );
  });

  it("404s when the job isn't found / not in the caller's workspace, writing nothing", async () => {
    findFirstMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("409s when the job exists but is not in a cancelable state", async () => {
    findFirstMock.mockResolvedValue(jobRow({ status: "in_progress" }));

    const res = await POST(req, ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOT_CANCELABLE");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("409s when the atomic update loses a race (e.g. the cron claimed it, count 0)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_CANCELABLE");
  });

  it("cross-workspace isolation: a job in another workspace 404s via the workspace-scoped read (not 403 — no existence oracle)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job

    const res = await POST(req, ctx("foreign-job"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { id: true, status: true, submittedForApprovalAt: true, approvedAt: true, storyOfPostJobId: true },
    });
  });
});

/// R3-client-journey M1: a Feed and Story post is one Queue card; with includePair
// the cancel takes both halves in one transaction (pairRule.ts).
const LATER = new Date("2026-11-20T15:00:00Z");

function pairRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "story-1",
    storyOfPostJobId: "job-1",
    status: "scheduled",
    scheduledFor: LATER,
    submittedForApprovalAt: null,
    approvedAt: null,
    ...overrides,
  };
}

function bodyReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/posts/[postJobId]/cancel - a Feed and Story card", () => {
  beforeEach(() => {
    updateManyMock.mockResolvedValue({ count: 1 });
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  });

  it("cancels both halves once each, in one transaction, each scoped and pinned like the single cancel", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow({ status: "draft", submittedForApprovalAt: SUBMITTED }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "cancelled",
      pair: { id: "story-1", kind: "story", changed: true, note: "Its Story was cancelled too." },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { storyOfPostJobId: "job-1", workspaceId: "ws-1" } }),
    );
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: {
        id: "story-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
        submittedForApprovalAt: SUBMITTED,
        approvedAt: null,
      },
      data: { status: "cancelled", submittedForApprovalAt: null },
    });
  });

  it("a Story card cancels its feed post too", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: "feed-1", ...jobRow() })
      .mockResolvedValueOnce(pairRow({ id: "feed-1", storyOfPostJobId: null }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect((await res.json()).pair).toEqual({
      id: "feed-1",
      kind: "feed",
      changed: true,
      note: "Its feed post was cancelled too.",
    });
    expect(findFirstMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "feed-1", workspaceId: "ws-1" } }),
    );
    expect(updateManyMock).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "feed-1" }) }));
  });

  it("without includePair only this post is cancelled, the pair is not read and the answer is as before", async () => {
    findFirstMock.mockResolvedValue({ id: "job-1", storyOfPostJobId: null, ...jobRow() });

    const res = await POST(bodyReq({}), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled" });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", "Its Story was already cancelled, so it was not cancelled."],
    ["in_progress", "Its Story has already started publishing, so it was not cancelled."],
    ["completed", "Its Story was already published, so it was not cancelled."],
  ])("the other half %s: this post is cancelled and the answer names the half left alone", async (status, note) => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow({ status }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "cancelled",
      pair: { id: "story-1", kind: "story", changed: false, note },
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("the other half changed in the meantime (its pinned write misses): this post is cancelled, the answer says so", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow());
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect((await res.json()).pair).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story changed in the meantime, so it was not cancelled.",
    });
  });

  it("a post with no other half: no pair in the answer", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() }).mockResolvedValueOnce(null);

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled" });
  });

  it("when this post cannot be cancelled, the other half is neither read nor written", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow({ status: "in_progress" }) });

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it("when this post's cancel loses its race, the other half is not written either", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow());
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("the cancel uses the mutate bucket", async () => {
    findFirstMock.mockResolvedValue(jobRow());

    await POST(req, ctx("job-1"));

    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ route: "posts/mutate", limit: 60 }));
  });
});

// The Queue no longer looks the other half up before a cancel or delete: the
// card is the pair, so there is nothing to ask.
describe("GET /api/posts/[postJobId]/cancel", () => {
  it("is gone with the per-half dialogs", async () => {
    const route: Record<string, unknown> = await import("./route");
    expect(route.GET).toBeUndefined();
  });
});
