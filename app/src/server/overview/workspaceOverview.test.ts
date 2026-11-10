import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  postJobGroupBy: vi.fn(),
  resultGroupBy: vi.fn(),
  connectionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: db.memberFindMany },
    postJob: { groupBy: db.postJobGroupBy },
    postJobResult: { groupBy: db.resultGroupBy },
    socialConnection: { findMany: db.connectionFindMany },
  },
}));

import { getWorkspacesOverview } from "./workspaceOverview";

const NOW = new Date("2026-11-10T15:00:00.000Z");

type PostJobGroupArgs = { by: string[]; where: Record<string, unknown> };

/** Which of the three post counts a `postJob.groupBy` call is. */
function postJobQueryKind(args: PostJobGroupArgs): "month" | "scheduled" | "approval" {
  if ("results" in args.where) return "month";
  if (args.where.status === "scheduled") return "scheduled";
  return "approval";
}

/** Serve the post counts per kind: `{ month: [...], scheduled: [...], approval: [...] }`. */
function servePostJobGroups(rows: Partial<Record<"month" | "scheduled" | "approval", unknown[]>>) {
  db.postJobGroupBy.mockImplementation(async (args: PostJobGroupArgs) => rows[postJobQueryKind(args)] ?? []);
}

function postJobCall(kind: "month" | "scheduled" | "approval"): PostJobGroupArgs {
  const call = db.postJobGroupBy.mock.calls.find(([args]) => postJobQueryKind(args) === kind);
  if (!call) throw new Error(`no ${kind} query`);
  return call[0];
}

const count = (workspaceId: string, n: number) => ({ workspaceId, _count: { _all: n } });

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.memberFindMany.mockResolvedValue([
    { role: "owner", workspace: { id: "ws-calm", name: "Calm Co" } },
    { role: "member", workspace: { id: "ws-busy", name: "Busy Co" } },
  ]);
  servePostJobGroups({});
  db.resultGroupBy.mockResolvedValue([]);
  db.connectionFindMany.mockResolvedValue([]);
});

describe("getWorkspacesOverview", () => {
  it("starts from the user's own memberships and scopes every count to them", async () => {
    await getWorkspacesOverview("user-1", NOW);

    expect(db.memberFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    const scoped = { in: ["ws-calm", "ws-busy"] };
    for (const [args] of db.postJobGroupBy.mock.calls) expect(args.where.workspaceId).toEqual(scoped);
    expect(db.resultGroupBy.mock.calls[0][0].where.workspaceId).toEqual(scoped);
    expect(db.connectionFindMany.mock.calls[0][0].where.workspaceId).toEqual(scoped);
  });

  it("shows only the user's workspaces, even if a count comes back for another", async () => {
    servePostJobGroups({ scheduled: [count("ws-other", 9)] });
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-other", platform: "x", needsReconnect: true },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.map((entry) => entry.workspaceId).sort()).toEqual(["ws-busy", "ws-calm"]);
    expect(overview.every((entry) => entry.scheduled === 0 && entry.needsReconnect.length === 0)).toBe(true);
  });

  it("returns nothing, and runs no counts, for a user with no workspaces", async () => {
    db.memberFindMany.mockResolvedValue([]);

    await expect(getWorkspacesOverview("user-1", NOW)).resolves.toEqual([]);
    expect(db.postJobGroupBy).not.toHaveBeenCalled();
    expect(db.resultGroupBy).not.toHaveBeenCalled();
    expect(db.connectionFindMany).not.toHaveBeenCalled();
  });

  it("runs a fixed number of grouped queries however many workspaces there are", async () => {
    db.memberFindMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        role: "owner",
        workspace: { id: `ws-${index}`, name: `W${index}` },
      })),
    );

    await getWorkspacesOverview("user-1", NOW);

    expect(db.postJobGroupBy).toHaveBeenCalledTimes(3);
    expect(db.resultGroupBy).toHaveBeenCalledTimes(1);
    expect(db.connectionFindMany).toHaveBeenCalledTimes(1);
    for (const [args] of db.postJobGroupBy.mock.calls) expect(args.by).toEqual(["workspaceId"]);
  });

  it("gives a workspace with no problems zeros and no attention mark", async () => {
    const overview = await getWorkspacesOverview("user-1", NOW);
    const calm = overview.find((entry) => entry.workspaceId === "ws-calm");

    expect(calm).toEqual({
      workspaceId: "ws-calm",
      name: "Calm Co",
      role: "owner",
      postsThisMonth: 0,
      scheduled: 0,
      waitingForApproval: 0,
      failedLast7Days: 0,
      failedPlatforms: [],
      needsReconnect: [],
      connected: 0,
      needsAttention: false,
    });
  });

  it("counts every field for a workspace with all of the problems", async () => {
    servePostJobGroups({
      month: [count("ws-busy", 12)],
      scheduled: [count("ws-busy", 4)],
      approval: [count("ws-busy", 2)],
    });
    db.resultGroupBy.mockResolvedValue([
      { workspaceId: "ws-busy", platform: "x", _count: { _all: 2 } },
      { workspaceId: "ws-busy", platform: "instagram", _count: { _all: 1 } },
    ]);
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-busy", platform: "linkedin", needsReconnect: true },
      { workspaceId: "ws-busy", platform: "x", needsReconnect: false },
      { workspaceId: "ws-busy", platform: "instagram", needsReconnect: false },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview[0]).toEqual({
      workspaceId: "ws-busy",
      name: "Busy Co",
      role: "member",
      postsThisMonth: 12,
      scheduled: 4,
      waitingForApproval: 2,
      failedLast7Days: 3,
      failedPlatforms: ["instagram", "x"],
      needsReconnect: ["linkedin"],
      connected: 3,
      needsAttention: true,
    });
  });

  it("marks a workspace with only some of the problems as needing attention", async () => {
    servePostJobGroups({ approval: [count("ws-calm", 1)] });

    const overview = await getWorkspacesOverview("user-1", NOW);
    const calm = overview.find((entry) => entry.workspaceId === "ws-calm");

    expect(calm?.waitingForApproval).toBe(1);
    expect(calm?.failedLast7Days).toBe(0);
    expect(calm?.needsAttention).toBe(true);
  });

  it("does not mark scheduled posts or posts this month as needing attention", async () => {
    servePostJobGroups({ month: [count("ws-calm", 5)], scheduled: [count("ws-calm", 5)] });

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.every((entry) => !entry.needsAttention)).toBe(true);
  });

  it("counts failed results finished in the last 7 days only", async () => {
    await getWorkspacesOverview("user-1", NOW);

    const args = db.resultGroupBy.mock.calls[0][0];
    expect(args.by).toEqual(["workspaceId", "platform"]);
    expect(args.where.status).toBe("failed");
    // A result that finished 7 days and a moment ago is outside this range.
    expect(args.where.updatedAt).toEqual({ gte: new Date("2026-11-03T15:00:00.000Z") });
  });

  it("counts waiting for approval as an undecided draft, as deriveApprovalState does", async () => {
    await getWorkspacesOverview("user-1", NOW);

    expect(postJobCall("approval").where).toEqual({
      workspaceId: { in: ["ws-calm", "ws-busy"] },
      status: "draft",
      submittedForApprovalAt: { not: null },
      approvedAt: null,
    });
  });

  it("counts posts this month by a successful result inside the current UTC month", async () => {
    await getWorkspacesOverview("user-1", NOW);

    expect(postJobCall("month").where.results).toEqual({
      some: {
        status: "success",
        updatedAt: {
          gte: new Date("2026-11-01T00:00:00.000Z"),
          lt: new Date("2026-12-01T00:00:00.000Z"),
        },
      },
    });
  });

  it("starts a new month at 00:00 UTC on the 1st", async () => {
    await getWorkspacesOverview("user-1", new Date("2026-12-01T00:00:00.000Z"));
    expect(postJobCall("month").where.results).toMatchObject({
      some: { updatedAt: { gte: new Date("2026-12-01T00:00:00.000Z") } },
    });

    db.postJobGroupBy.mockClear();
    await getWorkspacesOverview("user-1", new Date("2026-11-30T23:59:59.999Z"));
    expect(postJobCall("month").where.results).toMatchObject({
      some: { updatedAt: { gte: new Date("2026-11-01T00:00:00.000Z") } },
    });
  });

  it("puts workspaces needing attention first, then the rest, each by name", async () => {
    db.memberFindMany.mockResolvedValue([
      { role: "owner", workspace: { id: "ws-d", name: "Delta" } },
      { role: "owner", workspace: { id: "ws-a", name: "alpha" } },
      { role: "owner", workspace: { id: "ws-c", name: "Charlie" } },
      { role: "owner", workspace: { id: "ws-b", name: "Bravo" } },
    ]);
    db.resultGroupBy.mockResolvedValue([{ workspaceId: "ws-d", platform: "x", _count: { _all: 1 } }]);
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-c", platform: "x", needsReconnect: true },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.map((entry) => entry.name)).toEqual(["Charlie", "Delta", "alpha", "Bravo"]);
  });
});
