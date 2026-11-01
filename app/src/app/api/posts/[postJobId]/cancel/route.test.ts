import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace` and
// `@/lib/db` at module scope, so both are mocked before the import below.
const { getWorkspaceContextMock, updateManyMock, findFirstMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  updateManyMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { updateMany: updateManyMock, findFirst: findFirstMock },
  },
}));

import { POST } from "./route";

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}
const req = {} as NextRequest;

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  updateManyMock.mockReset();
  findFirstMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
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
      select: { status: true, submittedForApprovalAt: true, approvedAt: true },
    });
  });
});
