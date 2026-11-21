import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// R5 pages M1 (review): the Disconnect dialog's count of scheduled posts that
// chose the platform, counted on the server in one query.
const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { postJob: { findMany: findManyMock } } }));

import { GET } from "./route";

function call(platform: string, workspaceId?: string) {
  const query = workspaceId === undefined ? "" : `?workspaceId=${workspaceId}`;
  return GET(new NextRequest(`http://localhost/api/connections/${platform}/scheduled-count${query}`), {
    params: Promise.resolve({ platform }),
  });
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/connections/[platform]/scheduled-count", () => {
  it("answers 401 signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await call("instagram", "ws-1")).status).toBe(401);
  });

  it("refuses another workspace's tab and a missing workspace id without reading posts", async () => {
    expect((await call("instagram", "ws-2")).status).toBe(409);
    expect((await call("instagram")).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown platform", async () => {
    expect((await call("myspace", "ws-1")).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("counts the workspace's scheduled posts whose chosen platforms name it, in one query", async () => {
    findManyMock.mockResolvedValue([
      { id: "a", storyOfPostJobId: null },
      { id: "b", storyOfPostJobId: null },
    ]);
    const response = await call("instagram", "ws-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 2 });
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where).toMatchObject({
      workspaceId: "ws-1",
      publishMetadata: { path: ["targetPlatforms"], array_contains: ["instagram"] },
    });
  });

  // R61 pages-a-2 L1: a post held for approval keeps its time and platforms,
  // and fails on the platform once approved, so it is counted too, by
  // dashboard/summary's AWAITING_APPROVAL rule with a time set.
  describe("posts waiting for approval", () => {
    type Row = {
      id: string;
      storyOfPostJobId: string | null;
      status: string;
      submittedForApprovalAt: Date | null;
      approvedAt: Date | null;
      scheduledFor: Date | null;
    };
    const at = new Date("2026-12-04T10:00:00Z");
    const row = (id: string, fields: Partial<Row>): Row => ({
      id,
      storyOfPostJobId: null,
      status: "draft",
      submittedForApprovalAt: null,
      approvedAt: null,
      scheduledFor: null,
      ...fields,
    });

    /** The where clause's fields this route uses, applied to rows (publishMetadata: every row names the platform). */
    function matches(where: Record<string, unknown>, r: Row): boolean {
      return Object.entries(where).every(([key, want]) => {
        if (key === "workspaceId" || key === "publishMetadata") return true;
        if (key === "OR") return (want as Record<string, unknown>[]).some((one) => matches(one, r));
        if (key === "AND") return (want as Record<string, unknown>[]).every((one) => matches(one, r));
        const have = r[key as keyof Row];
        if (want === null) return have === null;
        if (typeof want === "object" && want !== null && "in" in want) return (want.in as unknown[]).includes(have);
        if (typeof want === "object" && want !== null && "not" in want && want.not === null) return have !== null;
        return have === want;
      });
    }

    async function countOf(rows: Row[]): Promise<number> {
      findManyMock.mockImplementation(async (args: { where: Record<string, unknown> }) => rows.filter((r) => matches(args.where, r)));
      return (await (await call("instagram", "ws-1")).json()).count;
    }

    it("a held draft with a time is counted", async () => {
      expect(await countOf([row("held", { submittedForApprovalAt: at, scheduledFor: at })])).toBe(1);
    });

    it("a scheduled post is counted", async () => {
      expect(await countOf([row("s", { status: "scheduled", scheduledFor: at, approvedAt: at })])).toBe(1);
    });

    it("an approved draft without a time is not counted", async () => {
      expect(await countOf([row("d", { submittedForApprovalAt: at, approvedAt: at })])).toBe(0);
    });

    it("a draft never submitted is not counted, and a held post without a time is not", async () => {
      expect(await countOf([row("plain", { scheduledFor: at }), row("held-no-time", { submittedForApprovalAt: at })])).toBe(0);
    });
  });

  it("counts a Feed and Story post once", async () => {
    findManyMock.mockResolvedValue([
      { id: "feed", storyOfPostJobId: null },
      { id: "story", storyOfPostJobId: "feed" },
      { id: "story-only-half", storyOfPostJobId: "other-feed" },
    ]);
    await expect((await call("instagram", "ws-1")).json()).resolves.toEqual({ count: 2 });
  });

  it("answers 500 with a sentence when the count fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findManyMock.mockRejectedValue(new Error("db down"));
    const response = await call("instagram", "ws-1");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("couldn't count");
  });
});
