import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  postJobGroupBy: vi.fn(),
  postJobFindMany: vi.fn(),
  resultGroupBy: vi.fn(),
  connectionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: db.memberFindMany },
    postJob: { groupBy: db.postJobGroupBy, findMany: db.postJobFindMany },
    postJobResult: { groupBy: db.resultGroupBy },
    socialConnection: { findMany: db.connectionFindMany },
  },
}));

import { getWorkspacesOverview, type WorkspaceOverviewEntry } from "./workspaceOverview";

const NOW = new Date("2026-11-10T15:00:00.000Z");

type GroupArgs = { by: string[]; where: Record<string, unknown> };
type PostJobKind = "scheduled" | "approval" | "clientChanges";
type ResultKind = "month";

/** Which post count a `postJob.groupBy` call is. */
const postJobKind = (args: GroupArgs): PostJobKind =>
  args.where.status === "scheduled"
    ? "scheduled"
    : "clientChangeRequestedAt" in args.where
      ? "clientChanges"
      : "approval";

type FindArgs = { where: Record<string, unknown> };
/** Which `postJob.findMany` call it is: the failed posts, the Story jobs, or their feed jobs. */
const findKind = (args: FindArgs): "failed" | "stories" | "feeds" =>
  "storyOfPostJobId" in args.where ? "stories" : "updatedAt" in args.where ? "failed" : "feeds";

interface JobRow {
  id: string;
  workspaceId: string;
  storyOfPostJobId: string | null;
  status?: string;
  submittedForApprovalAt?: Date | null;
  approvedAt?: Date | null;
  clientChangeRequestedAt?: Date | null;
  results?: { platform: string }[];
}

/** Serves the failed posts, and the jobs the pair look-ups pick from (filtered by id as the database would). */
function serveJobs({ failedPosts = [], jobs = [] }: { failedPosts?: JobRow[]; jobs?: JobRow[] }) {
  db.postJobFindMany.mockImplementation(async (args: FindArgs) => {
    const kind = findKind(args);
    if (kind === "failed") return failedPosts;
    if (kind === "stories") return jobs.filter((job) => job.storyOfPostJobId !== null);
    const ids = (args.where.id as { in: string[] }).in;
    return jobs.filter((job) => ids.includes(job.id));
  });
}

function servePostJobGroups(rows: Partial<Record<PostJobKind, unknown[]>>) {
  db.postJobGroupBy.mockImplementation(async (args: GroupArgs) => rows[postJobKind(args)] ?? []);
}
function serveResultGroups(rows: Partial<Record<ResultKind, unknown[]>>) {
  // The one result query: posts this month.
  db.resultGroupBy.mockImplementation(async () => rows.month ?? []);
}

function postJobCall(kind: PostJobKind): GroupArgs {
  const call = db.postJobGroupBy.mock.calls.find(([args]) => postJobKind(args) === kind);
  if (!call) throw new Error(`no ${kind} query`);
  return call[0];
}
function resultCall(kind: ResultKind): GroupArgs {
  const call = db.resultGroupBy.mock.calls[0];
  if (!call) throw new Error(`no ${kind} query`);
  return call[0];
}

const count = (workspaceId: string, n: number) => ({ workspaceId, _count: { _all: n } });
/** The month query's rows: one per (workspace, post) with a successful result this month. */
const posts = (workspaceId: string, n: number) =>
  Array.from({ length: n }, (_, index) => ({ workspaceId, postJobId: `${workspaceId}-p${index}` }));

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.memberFindMany.mockResolvedValue([
    { role: "owner", workspace: { id: "ws-calm", name: "Calm Co" } },
    { role: "member", workspace: { id: "ws-busy", name: "Busy Co" } },
  ]);
  servePostJobGroups({});
  serveResultGroups({});
  db.connectionFindMany.mockResolvedValue([]);
  serveJobs({});
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

    expect(db.postJobGroupBy).toHaveBeenCalledTimes(3);
    expect(db.resultGroupBy).toHaveBeenCalledTimes(1);
    // The failed posts and the Story jobs; no Story matched, so no feed look-up.
    expect(db.postJobFindMany).toHaveBeenCalledTimes(2);
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
      clientChangesRequested: 0,
      chooseGoogleLocation: false,
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
    serveResultGroups({ month: posts("ws-busy", 12) });
    serveJobs({
      failedPosts: [
        { id: "f1", workspaceId: "ws-busy", storyOfPostJobId: null, results: [{ platform: "x" }] },
        {
          id: "f2",
          workspaceId: "ws-busy",
          storyOfPostJobId: null,
          results: [{ platform: "x" }, { platform: "instagram" }],
        },
        // Failed before any platform took it.
        { id: "f3", workspaceId: "ws-busy", storyOfPostJobId: null, results: [] },
      ],
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
      clientChangesRequested: 0,
      chooseGoogleLocation: false,
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

  it("counts posts that failed in the last 7 days as Needs you does", async () => {
    await getWorkspacesOverview("user-1", NOW);

    const call = db.postJobFindMany.mock.calls.find(([args]) => findKind(args) === "failed");
    expect(call?.[0].where).toEqual({
      workspaceId: { in: ["ws-calm", "ws-busy"] },
      // A post that changed 7 days and a moment ago is outside this range.
      updatedAt: { gte: new Date("2026-11-03T15:00:00.000Z") },
      status: { not: "cancelled" },
      OR: [{ status: "failed" }, { results: { some: { status: "failed" } } }],
    });
  });

  it("counts waiting for approval exactly as Needs you: a held draft or scheduled post", async () => {
    await getWorkspacesOverview("user-1", NOW);

    expect(postJobCall("approval").where).toEqual({
      workspaceId: { in: ["ws-calm", "ws-busy"] },
      status: { in: ["draft", "scheduled"] },
      submittedForApprovalAt: { not: null },
      approvedAt: null,
    });
  });

  it("counts an old scheduled, submitted, unapproved Feed and Story pair as one post waiting", async () => {
    servePostJobGroups({ approval: [count("ws-busy", 2)], scheduled: [count("ws-busy", 2)] });
    const held = { status: "scheduled", submittedForApprovalAt: new Date("2026-09-01T00:00:00Z"), approvedAt: null };
    serveJobs({
      jobs: [
        { id: "feed-9", workspaceId: "ws-busy", storyOfPostJobId: null, ...held },
        { id: "story-9", workspaceId: "ws-busy", storyOfPostJobId: "feed-9", ...held },
      ],
    });

    const busy = (await getWorkspacesOverview("user-1", NOW)).find((entry) => entry.workspaceId === "ws-busy");

    expect(busy?.waitingForApproval).toBe(1);
  });

  // R6-client-journey L4: only an owner decides approvals, so, as Needs you,
  // posts waiting for one are not a member's to act on.
  it("marks waiting for approval as needing attention for an owner only", async () => {
    servePostJobGroups({ approval: [count("ws-calm", 2), count("ws-busy", 3)] });

    const overview = await getWorkspacesOverview("user-1", NOW);
    const calm = overview.find((entry) => entry.workspaceId === "ws-calm");
    const busy = overview.find((entry) => entry.workspaceId === "ws-busy");

    expect(calm).toMatchObject({ role: "owner", waitingForApproval: 2, needsAttention: true });
    expect(busy).toMatchObject({ role: "member", waitingForApproval: 3, needsAttention: false });
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
    serveJobs({
      failedPosts: [{ id: "f1", workspaceId: "ws-d", storyOfPostJobId: null, results: [{ platform: "x" }] }],
    });
    db.connectionFindMany.mockResolvedValue([
      { workspaceId: "ws-c", platform: "x", needsReconnect: true },
    ]);

    const overview = await getWorkspacesOverview("user-1", NOW);

    expect(overview.map((entry) => entry.name)).toEqual(["Charlie", "Delta", "alpha", "Bravo"]);
  });

  describe("a Feed and Story post counts once (R5-client-journey L2)", () => {
    const feed = { id: "feed-1", workspaceId: "ws-busy", storyOfPostJobId: null };
    const story = { id: "story-1", workspaceId: "ws-busy", storyOfPostJobId: "feed-1" };
    const busyOf = (overview: WorkspaceOverviewEntry[]) =>
      overview.find((entry) => entry.workspaceId === "ws-busy") as WorkspaceOverviewEntry;

    it("in posts this month when both halves went out", async () => {
      serveResultGroups({
        month: [
          { workspaceId: "ws-busy", postJobId: "feed-1" },
          { workspaceId: "ws-busy", postJobId: "story-1" },
          { workspaceId: "ws-busy", postJobId: "p3" },
        ],
      });
      serveJobs({ jobs: [feed, story] });

      expect(busyOf(await getWorkspacesOverview("user-1", NOW)).postsThisMonth).toBe(2);
    });

    it("in scheduled, waiting for approval and client changes", async () => {
      servePostJobGroups({
        scheduled: [count("ws-busy", 3)],
        approval: [count("ws-busy", 2)],
        clientChanges: [count("ws-busy", 2)],
      });
      const held = { status: "draft", submittedForApprovalAt: NOW, approvedAt: null, clientChangeRequestedAt: NOW };
      serveJobs({
        jobs: [
          { ...feed, status: "scheduled" },
          { ...story, status: "scheduled" },
          { id: "feed-2", workspaceId: "ws-busy", storyOfPostJobId: null, ...held },
          { id: "story-2", workspaceId: "ws-busy", storyOfPostJobId: "feed-2", ...held },
        ],
      });

      const busy = busyOf(await getWorkspacesOverview("user-1", NOW));

      expect(busy.scheduled).toBe(2);
      expect(busy.waitingForApproval).toBe(1);
      expect(busy.clientChangesRequested).toBe(1);
    });

    it("keeps a Story whose feed job does not match", async () => {
      servePostJobGroups({ scheduled: [count("ws-busy", 1)] });
      serveJobs({ jobs: [{ ...feed, status: "published" }, { ...story, status: "scheduled" }] });

      expect(busyOf(await getWorkspacesOverview("user-1", NOW)).scheduled).toBe(1);
    });

    it("in failed posts, listing every platform either half failed on", async () => {
      serveJobs({
        failedPosts: [
          { ...feed, results: [{ platform: "instagram" }] },
          { ...story, results: [{ platform: "instagram" }, { platform: "facebook_page" }] },
        ],
      });

      const busy = busyOf(await getWorkspacesOverview("user-1", NOW));

      expect(busy.failedLast7Days).toBe(1);
      expect(busy.failedPlatforms).toEqual(["facebook_page", "instagram"]);
    });
  });

  describe("what else needs attention, as Needs you (R5-client-journey L1)", () => {
    it("a client's change request", async () => {
      servePostJobGroups({ clientChanges: [count("ws-calm", 1)] });

      const calm = (await getWorkspacesOverview("user-1", NOW)).find((entry) => entry.workspaceId === "ws-calm");

      expect(calm?.clientChangesRequested).toBe(1);
      expect(calm?.needsAttention).toBe(true);
      expect(postJobCall("clientChanges").where).toEqual({
        workspaceId: { in: ["ws-calm", "ws-busy"] },
        status: { in: ["draft", "scheduled"] },
        clientChangeRequestedAt: { not: null },
      });
    });

    it("a Google listing with no location chosen, for an owner only", async () => {
      db.connectionFindMany.mockResolvedValue([
        { workspaceId: "ws-calm", platform: "google_business_profile", needsReconnect: false, metadata: {} },
        { workspaceId: "ws-busy", platform: "google_business_profile", needsReconnect: false, metadata: null },
      ]);

      const overview = await getWorkspacesOverview("user-1", NOW);
      const calm = overview.find((entry) => entry.workspaceId === "ws-calm");
      const busy = overview.find((entry) => entry.workspaceId === "ws-busy");

      expect(calm?.chooseGoogleLocation).toBe(true);
      expect(calm?.needsAttention).toBe(true);
      // ws-busy's user is a member: only an owner can choose it, as Needs you shows it to owners only.
      expect(busy?.chooseGoogleLocation).toBe(false);
      expect(busy?.needsAttention).toBe(false);
    });

    it("not a Google listing whose location is chosen", async () => {
      db.connectionFindMany.mockResolvedValue([
        {
          workspaceId: "ws-calm",
          platform: "google_business_profile",
          needsReconnect: false,
          metadata: { locationName: "locations/123" },
        },
      ]);

      const calm = (await getWorkspacesOverview("user-1", NOW)).find((entry) => entry.workspaceId === "ws-calm");

      expect(calm?.chooseGoogleLocation).toBe(false);
      expect(calm?.needsAttention).toBe(false);
    });
  });
});
