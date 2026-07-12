import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace`,
// `@/lib/db` and `@/lib/scheduling` (kept REAL — pure guards) at module
// scope; `Prisma` from `@prisma/client` is real too (the handler uses
// `Prisma.DbNull`).
const {
  getWorkspaceContextMock,
  findFirstMock,
  updateManyMock,
  deleteManyMock,
  postJobResultFindManyMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  postJobResultFindManyMock: vi.fn(),
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      deleteMany: deleteManyMock,
    },
    postJobResult: { findMany: postJobResultFindManyMock },
  },
}));

import { PATCH, DELETE, GET } from "./route";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function ctx(postJobId: string) {
  // route.ts reads context.params synchronously (cast, not awaited).
  return { params: { postJobId } };
}
function req(body: unknown, throwOnJson = false): NextRequest {
  return {
    json: async () => {
      if (throwOnJson) throw new Error("bad json");
      return body;
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  deleteManyMock.mockReset();
  postJobResultFindManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  updateManyMock.mockResolvedValue({ count: 1 });
  deleteManyMock.mockResolvedValue({ count: 1 });
  postJobResultFindManyMock.mockResolvedValue([]);
});

describe("GET /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't in the caller's active workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("scopes the ownership read to workspaceId (not userId) — cross-workspace isolation", async () => {
    findFirstMock.mockResolvedValue({ id: "job-1" });

    await GET(req(null), ctx("job-1"));

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
    });
  });

  it("a job belonging to a DIFFERENT workspace 404s, not 403 (no existence oracle)", async () => {
    // The caller's active workspace is ws-1; simulate the real-DB outcome for
    // a job that actually lives in ws-2 — the where clause wouldn't match it,
    // so Prisma would return null, same as "doesn't exist".
    findFirstMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("foreign-job"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("PATCH /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const res = await PATCH(req(undefined, true), ctx("job-1"));
    expect(res.status).toBe(400);
  });

  it("400s when baseCaption is provided but empty", async () => {
    const res = await PATCH(req({ baseCaption: "   " }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't the caller's", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await PATCH(req({ baseCaption: "new" }), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("409s NOT_EDITABLE when the job isn't scheduled/draft", async () => {
    findFirstMock.mockResolvedValue({ status: "in_progress" });
    const res = await PATCH(req({ baseCaption: "new" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_EDITABLE");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("400s NOT_SCHEDULED when trying to set scheduledFor on a draft", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({ scheduledFor: FUTURE }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_SCHEDULED");
  });

  it("edits a scheduled job's caption + time via an atomic owner/status-scoped update", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });

    const res = await PATCH(
      req({ baseCaption: "updated", scheduledFor: FUTURE }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
      data: { baseCaption: "updated", scheduledFor: new Date(FUTURE) },
    });
  });

  it("400s when there is nothing to update", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({}), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("409s when the atomic write loses the race (count 0)", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(409);
  });

  it("cross-workspace isolation: a job in another workspace 404s (the ownership read is workspace-scoped, not user-scoped)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await PATCH(req({ baseCaption: "x" }), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { status: true },
    });
  });
});

describe("DELETE /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("deletes a draft/cancelled job via an atomic owner/status-scoped delete", async () => {
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
  });

  it("404s when nothing matched and no such job exists", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("cross-workspace isolation: a job in another workspace 404s via the workspace-scoped disambiguation read", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await DELETE(req(null), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { id: true },
    });
  });

  it("409s NOT_DELETABLE when the job exists but is in a non-deletable state", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ id: "job-1" }); // e.g. scheduled
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_DELETABLE");
  });
});
