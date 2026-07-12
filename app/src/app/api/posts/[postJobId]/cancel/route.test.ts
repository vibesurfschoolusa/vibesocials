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

describe("POST /api/posts/[postJobId]/cancel", () => {
  it("401s and never touches the DB when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cancels a scheduled/draft job via an atomic workspace+status-scoped update", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req, ctx("job-1"));
    const body = (await res.json()) as { ok?: boolean; status?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "cancelled" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        workspaceId: "ws-1",
        status: { in: ["scheduled", "draft"] },
      },
      data: { status: "cancelled" },
    });
    // Won on the atomic update — no disambiguation read needed.
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't found / not in the caller's workspace (count 0, no such job)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(404);
  });

  it("409s when the job exists but is not in a cancelable state", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ id: "job-1" }); // e.g. already in_progress

    const res = await POST(req, ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOT_CANCELABLE");
  });

  it("cross-workspace isolation: a job in another workspace 404s via the workspace-scoped disambiguation read (not 403 — no existence oracle)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job

    const res = await POST(req, ctx("foreign-job"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { id: true },
    });
  });
});
