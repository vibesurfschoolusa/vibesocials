import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/auth`, `@/lib/db`
// and `@/lib/scheduling` (kept REAL — pure guards) at module scope; `Prisma`
// from `@prisma/client` is real too (the handler uses `Prisma.DbNull`).
const { getCurrentUserMock, findFirstMock, updateManyMock, deleteManyMock } =
  vi.hoisted(() => ({
    getCurrentUserMock: vi.fn(),
    findFirstMock: vi.fn(),
    updateManyMock: vi.fn(),
    deleteManyMock: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      deleteMany: deleteManyMock,
    },
  },
}));

import { PATCH, DELETE } from "./route";

const OWNER = { id: "user-1", email: "owner@example.com" };
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
  getCurrentUserMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  deleteManyMock.mockReset();
  getCurrentUserMock.mockResolvedValue(OWNER);
  updateManyMock.mockResolvedValue({ count: 1 });
  deleteManyMock.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);
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
      where: { id: "job-1", userId: "user-1", status: { in: ["scheduled", "draft"] } },
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
});

describe("DELETE /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("deletes a draft/cancelled job via an atomic owner/status-scoped delete", async () => {
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1", status: { in: ["draft", "cancelled"] } },
    });
  });

  it("404s when nothing matched and no such job exists", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("409s NOT_DELETABLE when the job exists but is in a non-deletable state", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ id: "job-1" }); // e.g. scheduled
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_DELETABLE");
  });
});
