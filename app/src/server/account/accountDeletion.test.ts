import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  rowsFindMany: vi.fn(),
  postJobFindFirst: vi.fn(),
  postJobGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: m.memberFindMany },
    workspace: { findMany: vi.fn(async () => []) },
    socialConnection: { findMany: m.rowsFindMany },
    mediaItem: { findMany: m.rowsFindMany },
    postJob: { findMany: m.rowsFindMany, findFirst: m.postJobFindFirst, groupBy: m.postJobGroupBy },
    postMetric: { findMany: m.rowsFindMany },
  },
}));

import { accountDeletionPreview, blockedMessage } from "./accountDeletion";

const day = new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  for (const mock of Object.values(m)) mock.mockReset();
  m.rowsFindMany.mockResolvedValue([]);
  m.postJobFindFirst.mockResolvedValue(null);
  m.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-personal", _count: { _all: 3 } }]);
});

describe("blockedMessage", () => {
  it("names one, two or three workspaces", () => {
    const tail = ". Make another member an owner, or delete the workspace, then try again.";
    expect(blockedMessage([{ workspaceId: "a", name: "A" }])).toBe(`You are the only owner of A${tail}`);
    expect(
      blockedMessage([
        { workspaceId: "a", name: "A" },
        { workspaceId: "b", name: "B" },
        { workspaceId: "c", name: "C" },
      ]),
    ).toBe(`You are the only owner of A, B and C${tail}`);
  });
});

describe("accountDeletionPreview", () => {
  it("lists what is deleted with scheduled counts and what is left", async () => {
    m.memberFindMany.mockResolvedValue([
      { role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } },
      {
        role: "member",
        workspace: { id: "ws-joined", name: "Joined", members: [{ userId: "u-2", role: "owner", createdAt: day }] },
      },
    ]);

    await expect(accountDeletionPreview("user-1")).resolves.toEqual({
      deleteWorkspaces: [{ name: "Personal", scheduledCount: 3 }],
      leaveWorkspaces: [{ name: "Joined" }],
      refusal: null,
    });
    expect(m.postJobGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: { in: ["ws-personal"] }, status: "scheduled" } }),
    );
  });

  it("gives the blocking sentence when the user is the only owner of a shared workspace", async () => {
    m.memberFindMany.mockResolvedValue([
      {
        role: "owner",
        workspace: { id: "ws-team", name: "Team", members: [{ userId: "u-2", role: "member", createdAt: day }] },
      },
    ]);
    m.postJobGroupBy.mockResolvedValue([]);

    const preview = await accountDeletionPreview("user-1");

    expect(preview.refusal).toBe(blockedMessage([{ workspaceId: "ws-team", name: "Team" }]));
    expect(preview.leaveWorkspaces).toEqual([]);
  });

  it("gives the publishing sentence while a post publishes", async () => {
    m.memberFindMany.mockResolvedValue([
      { role: "owner", workspace: { id: "ws-personal", name: "Personal", members: [] } },
    ]);
    m.postJobFindFirst.mockResolvedValue({ id: "job-1" });

    const preview = await accountDeletionPreview("user-1");

    expect(preview.refusal).toBe("A post is publishing right now. Try again in a few minutes.");
  });
});
