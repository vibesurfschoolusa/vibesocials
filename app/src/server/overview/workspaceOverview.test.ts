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

type GroupArgs = { by: string[]; where: Record<string, unknown> };
type PostJobKind = "scheduled" | "approval";
type ResultKind = "month" | "failed";

/** Which post count a `postJob.groupBy` call is. */
const postJobKind = (args: GroupArgs): PostJobKind =>
  args.where.status === "scheduled" ? "scheduled" : "approval";
/** Which result query a `postJobResult.groupBy` call is. */
const resultKind = (args: GroupArgs): ResultKind => (args.by.includes("postJobId") ? "month" : "failed");

function servePostJobGroups(rows: Partial<Record<PostJobKind, unknown[]>>) {
  db.postJobGroupBy.mockImplementation(async (args: GroupArgs) => rows[postJobKind(args)] ?? []);
}
function serveResultGroups(rows: Partial<Record<ResultKind, unknown[]>>) {
  db.resultGroupBy.mockImplementation(async (args: GroupArgs) => rows[resultKind(args)] ?? []);
}

function postJobCall(kind: PostJobKind): GroupArgs {
  const call = db.postJobGroupBy.mock.calls.find(([args]) => postJobKind(args) === kind);
  if (!call) throw new Error(`no ${kind} query`);
  return call[0];
}
function resultCall(kind: ResultKind): GroupArgs {
  const call = db.resultGroupBy.mock.calls.find(([args]) => resultKind(args) === kind);
  if (!call) throw new Error(`no ${kind} query`);
  return call[0];
}

const count = (workspaceId: string, n: number) => ({ workspaceId, _count: { _all: n } });
/** The month query's rows: one per (workspace, post) with a successful result this month. */
const posts = (workspaceId: string, n: number) =>
  Array.from({ length: n }, (_, index) => ({ workspaceId, postJobId: `${workspaceId}-p${index}` }));
const failed = (workspaceId: string, platform: string, n: number) => ({
  workspaceId,
  platform,
  _count: { _all: n },
});

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.memberFindMany.mockResolvedValue([
    { role: "owner", workspace: { id: "ws-calm", name: "Calm Co" } },
    { role: "member", workspace: { id: "ws-busy", name: "Busy Co" } },
  ]);
  servePostJobGroups({});
  serveResultGroups({});
  db.connectionFindMany.mockResolvedValue([]);
});

describe("getWorkspacesOverview", () => {
  it("starts from the user's own memberships and scopes every count to them", async () => {
    await getWorkspacesOverview("user-1", NOW);

    expect(db.memberFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    const scoped = { in: ["ws-calm", "ws-busy"] };
    for (const [args] of db.postJobGroupBy.mock.calls) expect(args.where.workspaceId).toEqual(scoped);
    for (const [args] of db.resultGroupBy.mock.calls) expect(args.where.workspaceId).toEqual(scoped);
    expect(db.connectionFindMany.mock.calls[0][0].where.workspaceId).toEqual(scoped);
  });

  it("shows only the user's workspaces, even if a count comes back for another", async () => {
    servePostJobGroups({ scheduled: [count("ws-other", 9)] });
    serveResultGroups({ month: posts("ws-other", 3) });
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-other", platform: "x", needsReconnect: true },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.map((entry) => entry.workspaceId).sort()).toEqual(["ws-busy", "ws-calm"]);
    expect(
      overview.every(
        (entry) => entry.scheduled === 0 && entry.postsThisMonth === 0 && entry.needsReconnect.length === 0,
      ),
    ).toBe(true);
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

    expect(db.postJobGroupBy).toHaveBeenCalledTimes(2);
    expect(db.resultGroupBy).toHaveBeenCalledTimes(2);
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
      scheduled: [count("ws-busy", 4)],
      approval: [count("ws-busy", 2)],
    });
    serveResultGroups({
      month: posts("ws-busy", 12),
      failed: [failed("ws-busy", "x", 2), failed("ws-busy", "instagram", 1)],
    });
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
    servePostJobGroups({ scheduled: [count("ws-calm", 5)] });
    serveResultGroups({ month: posts("ws-calm", 5) });

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.every((entry) => !entry.needsAttention)).toBe(true);
  });

  it("counts failed results finished in the last 7 days only", async () => {
    await getWorkspacesOverview("user-1", NOW);

    const args = resultCall("failed");
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

  it("counts posts this month from successful results inside the current UTC month", async () => {
    await getWorkspacesOverview("user-1", NOW);

    // Straight on PostJobResult, served by its [workspaceId, updatedAt] index.
    expect(db.postJobGroupBy.mock.calls.some(([args]) => "results" in args.where)).toBe(false);
    expect(resultCall("month")).toEqual({
      by: ["workspaceId", "postJobId"],
      where: {
        workspaceId: { in: ["ws-calm", "ws-busy"] },
        status: "success",
        updatedAt: {
          gte: new Date("2026-11-01T00:00:00.000Z"),
          lt: new Date("2026-12-01T00:00:00.000Z"),
        },
      },
    });
  });

  it("counts each post once per workspace, however many platforms it succeeded on", async () => {
    // groupBy returns one row per (workspace, post), so a post that went out on
    // three platforms is one row; the count is the rows per workspace.
    serveResultGroups({
      month: [
        { workspaceId: "ws-busy", postJobId: "p1" },
        { workspaceId: "ws-busy", postJobId: "p2" },
        { workspaceId: "ws-calm", postJobId: "p3" },
      ],
    });

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(Object.fromEntries(overview.map((entry) => [entry.workspaceId, entry.postsThisMonth]))).toEqual({
      "ws-busy": 2,
      "ws-calm": 1,
    });
  });

  it("starts a new month at 00:00 UTC on the 1st", async () => {
    await getWorkspacesOverview("user-1", new Date("2026-12-01T00:00:00.000Z"));
    expect(resultCall("month").where.updatedAt).toEqual({
      gte: new Date("2026-12-01T00:00:00.000Z"),
      lt: new Date("2027-01-01T00:00:00.000Z"),
    });

    db.resultGroupBy.mockClear();
    await getWorkspacesOverview("user-1", new Date("2026-11-30T23:59:59.999Z"));
    expect(resultCall("month").where.updatedAt).toEqual({
      gte: new Date("2026-11-01T00:00:00.000Z"),
      lt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("puts workspaces needing attention first, then the rest, each by name", async () => {
    db.memberFindMany.mockResolvedValue([
      { role: "owner", workspace: { id: "ws-d", name: "Delta" } },
      { role: "owner", workspace: { id: "ws-a", name: "alpha" } },
      { role: "owner", workspace: { id: "ws-c", name: "Charlie" } },
      { role: "owner", workspace: { id: "ws-b", name: "Bravo" } },
    ]);
    serveResultGroups({ failed: [failed("ws-d", "x", 1)] });
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-c", platform: "x", needsReconnect: true },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.map((entry) => entry.name)).toEqual(["Charlie", "Delta", "alpha", "Bravo"]);
  });
});
