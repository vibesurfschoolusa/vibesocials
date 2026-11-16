import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, findManyMock, workspaceFindUniqueMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
  workspaceFindUniqueMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: { postJob: { findMany: findManyMock }, workspace: { findUnique: workspaceFindUniqueMock } },
}));

import {
  MISSING_WORKSPACE_ID_CODE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";
import { GET } from "./route";

/** R32: a read from a page drawn for `workspaceId` (the mock's own by default; null sends none). */
function req(workspaceId: string | null = "ws-7", query = ""): Request {
  const address = new URL(`http://localhost/api/posts/scheduled-times${query}`);
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address);
}

const NOW = new Date("2026-11-10T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-7" }));
  findManyMock.mockResolvedValue([]);
  workspaceFindUniqueMock.mockReset();
  workspaceFindUniqueMock.mockResolvedValue({ postingSlots: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// R32 new-customer L3: Create's "Next free slot" and Add many on a page drawn
// for another workspace get the switch sentence, never this one's times.
describe("GET /api/posts/scheduled-times - the page's workspace", () => {
  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(req("ws-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(MISSING_WORKSPACE_ID_CODE);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts/scheduled-times", () => {
  it("401s when unauthenticated and reads nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // A draft has a time only while it is held (for approval, or a client's
  // change request); a plain draft has none, so the time range leaves it out.
  it("reads this workspace's scheduled posts and drafts with a time, from now to 90 days ahead, at most 500, times only", async () => {
    await GET(req());

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

  it("answers with the times and nothing else about the posts, beside this workspace's posting times", async () => {
    findManyMock.mockResolvedValue([
      { scheduledFor: new Date("2026-11-12T09:00:00.000Z") },
      { scheduledFor: new Date("2026-11-19T09:00:00.000Z") },
    ]);
    workspaceFindUniqueMock.mockResolvedValue({ postingSlots: [{ day: 4, time: "09:00" }] });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(workspaceFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "ws-7" },
      select: { postingSlots: true },
    });
    await expect(res.json()).resolves.toEqual({
      times: ["2026-11-12T09:00:00.000Z", "2026-11-19T09:00:00.000Z"],
      slots: [{ day: 4, time: "09:00" }],
    });
  });

  it("gives no posting times when none are saved", async () => {
    const res = await GET(req());
    await expect(res.json()).resolves.toEqual({ times: [], slots: [] });
  });
});
