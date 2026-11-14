import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace` and
// `@/lib/db` at module scope, so both are mocked before the import below.
const { getWorkspaceContextMock, updateManyMock, findFirstMock, findUniqueMock, mediaUpdateManyMock, checkRateLimitMock } = vi.hoisted(
  () => ({
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
  },
}));

import { GET, POST } from "./route";

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

// R2-client-journey M1: a Feed and Story post is two jobs; the dialog can cancel both in one request.
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

describe("POST /api/posts/[postJobId]/cancel - with the other half of a Feed and Story post", () => {
  beforeEach(() => {
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("cancels both halves when includePair is sent, each scoped and pinned like the single cancel", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow({ status: "draft", submittedForApprovalAt: SUBMITTED }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled", pair: "cancelled" });
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

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled", pair: "cancelled" });
    expect(findFirstMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "feed-1", workspaceId: "ws-1" } }),
    );
    expect(updateManyMock).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "feed-1" }) }));
  });

  it("without includePair only this post is cancelled and the pair is not read", async () => {
    findFirstMock.mockResolvedValue({ id: "job-1", storyOfPostJobId: null, ...jobRow() });

    const res = await POST(bodyReq({}), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled" });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("the other half already cancelled: this post is cancelled and the answer says there was none", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow({ status: "cancelled" }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled", pair: "none" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("the other half already publishing: this post is cancelled and the answer says the other was not", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow({ status: "in_progress" }));

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled", pair: "not_cancelable" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("a post with no other half: the answer says none", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() }).mockResolvedValueOnce(null);

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true, status: "cancelled", pair: "none" });
  });

  it("when this post cannot be cancelled, the other half is left alone", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow({ status: "in_progress" }) });

    const res = await POST(bodyReq({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/posts/[postJobId]/cancel - the other half, for the dialog", () => {
  it("names the other half's kind, state and time", async () => {
    findFirstMock
      .mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() })
      .mockResolvedValueOnce(pairRow());

    const res = await GET(req, ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      pair: { id: "story-1", kind: "story", status: "scheduled", scheduledFor: LATER.toISOString() },
    });
    expect(findFirstMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: "job-1", workspaceId: "ws-1" } }));
  });

  // Coordinator review point 2: the lookup only reads, so it has its own, looser
  // bucket and never spends the cancel / edit / delete allowance.
  it("uses its own read bucket, not the mutate one", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() }).mockResolvedValueOnce(null);

    await GET(req, ctx("job-1"));

    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "posts/pair-lookup",
      limit: 300,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("the cancel itself still uses the mutate bucket", async () => {
    findFirstMock.mockResolvedValue(jobRow());
    updateManyMock.mockResolvedValue({ count: 1 });

    await POST(req, ctx("job-1"));

    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ route: "posts/mutate", limit: 60 }));
  });

  it("429 with Retry-After when the read bucket is spent", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 9 });

    const res = await GET(req, ctx("job-1"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("null when there is no live other half", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "job-1", storyOfPostJobId: null, ...jobRow() }).mockResolvedValueOnce(null);

    const res = await GET(req, ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ pair: null });
  });

  it("401 signed out, 404 for a post in another workspace", async () => {
    getWorkspaceContextMock.mockResolvedValueOnce(null);
    expect((await GET(req, ctx("job-1"))).status).toBe(401);

    findFirstMock.mockResolvedValueOnce(null);
    expect((await GET(req, ctx("foreign"))).status).toBe(404);
  });
});
