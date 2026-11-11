import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  memberGroupBy: vi.fn(),
  connectionGroupBy: vi.fn(),
  postJobGroupBy: vi.fn(),
  queryRaw: vi.fn(),
  actionFindMany: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findMany: db.workspaceFindMany, findUnique: db.workspaceFindUnique },
    workspaceMember: { groupBy: db.memberGroupBy },
    socialConnection: { groupBy: db.connectionGroupBy },
    postJob: { groupBy: db.postJobGroupBy },
    adminAction: { findMany: db.actionFindMany },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock("@/server/usage/workspaceUsage", () => ({ getWorkspaceUsageOrNull: db.usage }));

import { PLANS } from "@/lib/plans";
import { DEFAULT_WORKSPACE_LIMITS } from "@/lib/usageLimits";

import { ADMIN_PAGE_SIZE, getAdminWorkspaceDetail, listAdminWorkspaces } from "./queries";

const NOW = new Date("2026-11-10T12:00:00Z");
const CREATED_A = new Date("2026-11-01T00:00:00Z");
const CREATED_B = new Date("2026-10-01T00:00:00Z");

function workspaceRow(id: string, createdAt: Date, owners: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Name ${id}`,
    createdAt,
    pausedAt: null,
    members: owners.map((email) => ({ user: { email } })),
    ...extra,
  };
}

function stubCounts() {
  db.memberGroupBy.mockResolvedValue([
    { workspaceId: "ws-a", _count: { _all: 3 } },
    { workspaceId: "ws-b", _count: { _all: 1 } },
  ]);
  db.connectionGroupBy.mockResolvedValue([
    { workspaceId: "ws-a", platform: "x", needsReconnect: false },
    { workspaceId: "ws-a", platform: "instagram", needsReconnect: true },
    { workspaceId: "ws-b", platform: "youtube", needsReconnect: false },
  ]);
  db.postJobGroupBy.mockResolvedValue([
    { workspaceId: "ws-a", status: "completed", _count: { _all: 7 } },
    { workspaceId: "ws-a", status: "failed", _count: { _all: 2 } },
    { workspaceId: "ws-b", status: "failed", _count: { _all: 4 } },
  ]);
  db.queryRaw.mockResolvedValue([
    { workspaceId: "ws-a", total: BigInt(3_000_000_000) },
    { workspaceId: "ws-b", total: 1024 },
  ]);
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
});

describe("listAdminWorkspaces", () => {
  it("lists newest first, 50 a page, with each workspace's counts from grouped queries", async () => {
    db.workspaceFindMany.mockResolvedValue([
      workspaceRow("ws-a", CREATED_A, ["a1@example.com", "a2@example.com"], { pausedAt: NOW }),
      workspaceRow("ws-b", CREATED_B, ["b@example.com"], { billingExempt: true }),
    ]);
    stubCounts();

    const result = await listAdminWorkspaces({ search: "", page: 0, now: NOW });

    const query = db.workspaceFindMany.mock.calls[0][0];
    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(query.skip).toBe(0);
    expect(query.take).toBe(ADMIN_PAGE_SIZE + 1);
    expect(query.where).toEqual({});
    expect(ADMIN_PAGE_SIZE).toBe(50);

    // One grouped query each, bounded to the workspaces on the page.
    for (const groupBy of [db.memberGroupBy, db.connectionGroupBy, db.postJobGroupBy]) {
      expect(groupBy).toHaveBeenCalledTimes(1);
      expect(groupBy.mock.calls[0][0].where.workspaceId).toEqual({ in: ["ws-a", "ws-b"] });
    }
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
    expect(db.postJobGroupBy.mock.calls[0][0].where).toEqual({
      workspaceId: { in: ["ws-a", "ws-b"] },
      status: { in: ["completed", "failed"] },
      updatedAt: { gte: new Date("2026-10-11T12:00:00Z") },
    });

    expect(result.hasNextPage).toBe(false);
    expect(result.rows).toEqual([
      {
        id: "ws-a",
        name: "Name ws-a",
        createdAt: CREATED_A,
        ownerEmails: ["a1@example.com", "a2@example.com"],
        memberCount: 3,
        platforms: ["instagram", "x"],
        reconnectCount: 1,
        published30d: 7,
        failed30d: 2,
        storageBytes: 3_000_000_000,
        pausedAt: NOW,
        // 21a: computed from the plan columns; this row has none and no start date applies.
        planState: "ended",
      },
      {
        id: "ws-b",
        name: "Name ws-b",
        createdAt: CREATED_B,
        ownerEmails: ["b@example.com"],
        memberCount: 1,
        platforms: ["youtube"],
        reconnectCount: 0,
        published30d: 0,
        failed30d: 4,
        storageBytes: 1024,
        pausedAt: null,
        planState: "exempt",
      },
    ]);
  });

  it("selects only what the list shows", async () => {
    db.workspaceFindMany.mockResolvedValue([]);
    await listAdminWorkspaces({ search: "", page: 0, now: NOW });
    expect(db.workspaceFindMany.mock.calls[0][0].select).toEqual({
      id: true,
      name: true,
      createdAt: true,
      pausedAt: true,
      // 21a: the plan columns, always: the list shows each workspace's plan state.
      billingExempt: true,
      plan: true,
      planStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      members: {
        where: { role: "owner" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { user: { select: { email: true } } },
      },
    });
    expect(db.connectionGroupBy).not.toHaveBeenCalled();
  });

  it("returns exactly the documented fields per row", async () => {
    db.workspaceFindMany.mockResolvedValue([
      { ...workspaceRow("ws-a", CREATED_A, ["a@example.com"]), secret: "x", companyWebsite: "y" },
    ]);
    stubCounts();
    const { rows } = await listAdminWorkspaces({ search: "", page: 0, now: NOW });
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "createdAt",
        "failed30d",
        "id",
        "memberCount",
        "name",
        "ownerEmails",
        "pausedAt",
        "planState",
        "platforms",
        "published30d",
        "reconnectCount",
        "storageBytes",
      ].sort(),
    );
  });

  it("searches the workspace name and the owners' emails, nothing else", async () => {
    db.workspaceFindMany.mockResolvedValue([]);
    await listAdminWorkspaces({ search: "  Surf  ", page: 2, now: NOW });
    const query = db.workspaceFindMany.mock.calls[0][0];
    expect(query.where).toEqual({
      OR: [
        { name: { contains: "Surf", mode: "insensitive" } },
        {
          members: {
            some: { role: "owner", user: { email: { contains: "Surf", mode: "insensitive" } } },
          },
        },
      ],
    });
    expect(query.skip).toBe(100);
  });

  it("says when there is a next page and shows only 50", async () => {
    db.workspaceFindMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => workspaceRow(`ws-${i}`, CREATED_A, [])),
    );
    db.memberGroupBy.mockResolvedValue([]);
    db.connectionGroupBy.mockResolvedValue([]);
    db.postJobGroupBy.mockResolvedValue([]);
    db.queryRaw.mockResolvedValue([]);
    const result = await listAdminWorkspaces({ search: "", page: 0, now: NOW });
    expect(result.rows).toHaveLength(50);
    expect(result.hasNextPage).toBe(true);
    expect(db.memberGroupBy.mock.calls[0][0].where.workspaceId.in).toHaveLength(50);
  });
});

describe("getAdminWorkspaceDetail", () => {
  const USAGE = {
    postsToday: { used: 3, limit: 50, resetsAt: NOW },
    xPostsThisMonth: { used: 1, limit: 30, resetsAt: NOW },
    youtubeUploadsToday: { used: 0, limit: 10, resetsAt: NOW },
    storage: { used: 10, limit: 100, resetsAt: null },
  };

  it("is null for a workspace that does not exist", async () => {
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await getAdminWorkspaceDetail("nope", NOW)).toBeNull();
    expect(db.actionFindMany).not.toHaveBeenCalled();
  });

  it("shows the row, the limits beside the defaults, the usage, the pause and the last 50 actions", async () => {
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow("ws-a", CREATED_A, ["a@example.com"]),
      pausedAt: NOW,
      pausedReason: "Unpaid invoice.",
      limitPostsPerDay: 50,
      limitXPostsPerMonth: null,
      limitYoutubeUploadsPerDay: null,
      limitStorageMb: 100,
    });
    stubCounts();
    db.usage.mockResolvedValue(USAGE);
    db.actionFindMany.mockResolvedValue([
      { id: "act-1", createdAt: NOW, operatorEmail: "ops@example.com", action: "pause", detail: { old: {}, new: {} } },
    ]);

    const detail = await getAdminWorkspaceDetail("ws-a", NOW);

    expect(db.workspaceFindUnique.mock.calls[0][0]).toEqual({
      where: { id: "ws-a" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        pausedAt: true,
        pausedReason: true,
        limitPostsPerDay: true,
        limitXPostsPerMonth: true,
        limitYoutubeUploadsPerDay: true,
        limitStorageMb: true,
        billingExempt: true,
        plan: true,
        planStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        members: {
          where: { role: "owner" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { user: { select: { email: true } } },
        },
      },
    });
    expect(db.actionFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-a" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: { id: true, createdAt: true, operatorEmail: true, action: true, detail: true },
    });
    expect(db.usage).toHaveBeenCalledWith("ws-a", NOW);

    expect(Object.keys(detail!).sort()).toEqual(
      ["actions", "billing", "defaultLimits", "effectiveLimits", "overrides", "pausedReason", "usage", "workspace"].sort(),
    );
    expect(detail!.workspace).toMatchObject({ id: "ws-a", memberCount: 3, reconnectCount: 1, pausedAt: NOW });
    expect(detail!.pausedReason).toBe("Unpaid invoice.");
    expect(detail!.overrides).toEqual({
      limitPostsPerDay: 50,
      limitXPostsPerMonth: null,
      limitYoutubeUploadsPerDay: null,
      limitStorageMb: 100,
    });
    expect(detail!.effectiveLimits.postsPerDay).toBe(50);
    expect(detail!.effectiveLimits.storageBytes).toBe(100 * 1024 * 1024);
    expect(detail!.defaultLimits.postsPerDay).toBe(
      Number(process.env.LIMIT_POSTS_PER_DAY ?? DEFAULT_WORKSPACE_LIMITS.postsPerDay),
    );
    expect(detail!.usage).toBe(USAGE);
    expect(detail!.actions).toHaveLength(1);
  });
});

// 21a: the stored plan fields and the computed state, billing on or off.
describe("getAdminWorkspaceDetail billing", () => {
  function stubDetail(extra: Record<string, unknown>) {
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow("ws-a", CREATED_A, ["a@example.com"]),
      pausedReason: null,
      limitPostsPerDay: null,
      limitXPostsPerMonth: null,
      limitYoutubeUploadsPerDay: null,
      limitStorageMb: null,
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      ...extra,
    });
    stubCounts();
    db.usage.mockResolvedValue(null);
    db.actionFindMany.mockResolvedValue([]);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("with billing off, shows the stored fields and the state they would give, and that it is off", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const trialEndsAt = new Date("2026-11-20T00:00:00Z");
    stubDetail({ trialEndsAt });
    const detail = await getAdminWorkspaceDetail("ws-a", NOW);
    expect(detail!.billing).toEqual({
      enabled: false,
      state: "trial",
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt,
      currentPeriodEnd: null,
    });
    expect(detail!.workspace.planState).toBe("trial");
  });

  it("with billing on, a workspace older than BILLING_STARTED_AT is exempt and its limits are today's", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("BILLING_STARTED_AT", "2026-11-05T00:00:00Z");
    stubDetail({ plan: "pro", planStatus: "active" });
    const detail = await getAdminWorkspaceDetail("ws-a", NOW);
    expect(detail!.billing.enabled).toBe(true);
    expect(detail!.billing.state).toBe("exempt");
  });

  it("with billing on, the limits in effect and the defaults are the plan's", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("BILLING_STARTED_AT", "2026-10-15T00:00:00Z");
    stubDetail({ plan: "pro", planStatus: "active", limitPostsPerDay: 3 });
    const detail = await getAdminWorkspaceDetail("ws-a", NOW);
    expect(detail!.billing.state).toBe("active");
    expect(detail!.effectiveLimits.postsPerDay).toBe(3);
    expect(detail!.effectiveLimits.xPostsPerMonth).toBe(PLANS.pro.limits.xPostsPerMonth);
    expect(detail!.defaultLimits.postsPerDay).toBe(PLANS.pro.limits.postsPerDay);
  });
});
