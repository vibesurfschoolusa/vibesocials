import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/auth` and
// `@/lib/db` at module scope, so both are mocked before the import below.
const { getCurrentUserMock, updateManyMock, findFirstMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  updateManyMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { updateMany: updateManyMock, findFirst: findFirstMock },
  },
}));

import { POST } from "./route";

const OWNER = { id: "user-1", email: "owner@example.com" };

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}
const req = {} as NextRequest;

beforeEach(() => {
  getCurrentUserMock.mockReset();
  updateManyMock.mockReset();
  findFirstMock.mockReset();
  getCurrentUserMock.mockResolvedValue(OWNER);
});

describe("POST /api/posts/[postJobId]/cancel", () => {
  it("401s and never touches the DB when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await POST(req, ctx("job-1"));

    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cancels a scheduled/draft job via an atomic owner+status-scoped update", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req, ctx("job-1"));
    const body = (await res.json()) as { ok?: boolean; status?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "cancelled" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        userId: "user-1",
        status: { in: ["scheduled", "draft"] },
      },
      data: { status: "cancelled" },
    });
    // Won on the atomic update — no disambiguation read needed.
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't found / not owned (count 0, no such job)", async () => {
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
});
