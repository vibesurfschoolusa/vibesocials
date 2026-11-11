import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { postJob: { findMany: findManyMock } } }));

import { GET } from "./route";

const NOW = new Date("2026-11-10T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-7" }));
  findManyMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/posts/scheduled-times", () => {
  it("401s when unauthenticated and reads nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // A draft has a time only while it is held (for approval, or a client's
  // change request); a plain draft has none, so the time range leaves it out.
  it("reads this workspace's scheduled posts and drafts with a time, from now to 90 days ahead, at most 500, times only", async () => {
    await GET();

    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-7",
        status: { in: ["scheduled", "draft"] },
        scheduledFor: { gte: NOW, lte: new Date("2027-02-08T12:00:00.000Z") },
      },
      orderBy: { scheduledFor: "asc" },
      take: 500,
      select: { scheduledFor: true },
    });
  });

  it("answers with the times and nothing else", async () => {
    findManyMock.mockResolvedValue([
      { scheduledFor: new Date("2026-11-12T09:00:00.000Z") },
      { scheduledFor: new Date("2026-11-19T09:00:00.000Z") },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      times: ["2026-11-12T09:00:00.000Z", "2026-11-19T09:00:00.000Z"],
    });
  });
});
