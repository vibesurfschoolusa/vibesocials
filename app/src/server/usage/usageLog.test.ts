import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventCreateMany: vi.fn(),
  eventCount: vi.fn(),
  eventFindMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  eventGroupBy: vi.fn(),
  postJobCount: vi.fn(),
  postJobFindMany: vi.fn(),
  postJobGroupBy: vi.fn(),
  resultFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  workspaceFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  connectionFindUnique: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    usageEvent: {
      create: db.eventCreate,
      createMany: db.eventCreateMany,
      count: db.eventCount,
      findMany: db.eventFindMany,
      deleteMany: db.eventDeleteMany,
      groupBy: db.eventGroupBy,
    },
    postJob: { count: db.postJobCount, findMany: db.postJobFindMany, groupBy: db.postJobGroupBy },
    postJobResult: { findMany: db.resultFindMany },
    workspaceMember: { findMany: db.memberFindMany },
    workspace: { findMany: db.workspaceFindMany, findUnique: db.workspaceFindUnique },
    socialConnection: { findUnique: db.connectionFindUnique },
    $queryRaw: db.queryRaw,
  },
}));

import { prisma } from "@/lib/db";

import {
  copyUsageBeforeDeletion,
  crossWorkspacePostRefusal,
  pruneUsageEvents,
  recordRetry,
  retryRefusal,
  serviceCapApplies,
  serviceCapRefusalAtSend,
  USAGE_EVENT_RETENTION_DAYS,
  recordWorkspaceCreated,
  workspaceCreationRefusal,
  xPostsThisMonth,
} from "./usageLog";

/**
 * R5-security M1: what the limits count must not multiply with workspaces or
 * start again when one is deleted.
 */

const NOW = new Date("2026-11-14T15:00:00.000Z");
const DAY_START = new Date("2026-11-14T00:00:00.000Z");
const DAY_END = new Date("2026-11-15T00:00:00.000Z");
const MONTH_START = new Date("2026-11-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const LONG_AGO = new Date("2026-10-01T00:00:00Z");
const OWNER = { userId: "owner-1", user: { email: "owner@example.com", emailVerifiedAt: LONG_AGO, createdAt: LONG_AGO } };
const TRIAL = { billingExempt: false, trialEndsAt: new Date("2026-11-20T00:00:00Z") };
const PAID = { billingExempt: false, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2026-12-10T00:00:00Z") };

beforeEach(() => {
  // Plan states are read at the current time.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const mock of Object.values(db)) mock.mockReset();
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
  db.eventCount.mockResolvedValue(0);
  db.eventGroupBy.mockResolvedValue([]);
  db.eventFindMany.mockResolvedValue([]);
  db.eventCreateMany.mockResolvedValue({ count: 0 });
  db.postJobCount.mockResolvedValue(0);
  db.postJobFindMany.mockResolvedValue([]);
  db.resultFindMany.mockResolvedValue([]);
  db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string; userId?: string } }) =>
    Promise.resolve(
      where.workspaceId
        ? [OWNER]
        : [{ workspace: { id: "ws-1" } }, { workspace: { id: "ws-2" } }],
    ),
  );
  db.workspaceFindMany.mockResolvedValue([]);
  db.postJobGroupBy.mockResolvedValue([]);
  db.workspaceFindUnique.mockResolvedValue({ billingExempt: false });
  db.connectionFindUnique.mockResolvedValue({ accountIdentifier: "x-account-7" });
  db.queryRaw.mockResolvedValue([{ count: 0 }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const postsOnDay = {
  status: { notIn: ["draft", "cancelled"] },
  OR: [
    { scheduledFor: { gte: DAY_START, lt: DAY_END } },
    { scheduledFor: null, createdAt: { gte: DAY_START, lt: DAY_END } },
  ],
};

// R6-security M2: the service's cap counts what went out, never a post still
// waiting for its slot, so scheduling far ahead reserves nothing.
const sentOnDay = {
  ...postsOnDay,
  status: { notIn: ["draft", "cancelled", "scheduled"] },
  results: { some: {} },
};

/** The owner's logged posts and retries on the day (R6-security M3: retries count with posts). */
const ownerLogged = (ownerId: string, workspaceIds: string[]) => ({
  where: {
    at: { gte: DAY_START, lt: DAY_END },
    OR: [
      { kind: "post", userId: ownerId },
      { kind: "retry", OR: [{ workspaceId: { in: workspaceIds } }, { userId: ownerId }] },
    ],
  },
});

describe("posts per owner per day, across the workspaces they own", () => {
  it("counts the posts of every owned workspace and the owner's logged posts of deleted ones", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 20 : 0),
    );
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 9 : 0));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();

    expect(db.memberFindMany).toHaveBeenCalledWith({
      where: { userId: "owner-1", role: "owner" },
      select: { workspace: { select: { id: true } } },
    });
    expect(db.postJobCount).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1", "ws-2"] }, ...postsOnDay } });
    expect(db.eventCount).toHaveBeenCalledWith(ownerLogged("owner-1", ["ws-1", "ws-2"]));
  });

  it("refuses the post that would pass 30, with a sentence that says it is the owner's total", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 20 : 20),
    );
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 10 : 0));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 30 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
    });
  });

  it("a deleted workspace's posts and retries still count: 0 live, 30 logged", async () => {
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 30 : 30));
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
  });

  it("adds the request's own posts and leaves out the posts being moved", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 29 : 29),
    );
    expect(
      await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule", alsoOnDay: 0 }),
    ).toBeNull();
    expect(
      await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule", alsoOnDay: 1 }),
    ).toMatchObject({ code: "OWNER_DAILY_POST_LIMIT" });

    db.postJobCount.mockClear();
    await crossWorkspacePostRefusal({
      workspaceId: "ws-1",
      workspace: {},
      day: NOW,
      mode: "schedule",
      excludePostJobId: ["feed-1", "story-1"],
    });
    for (const [args] of db.postJobCount.mock.calls) {
      expect(args.where.id).toEqual({ notIn: ["feed-1", "story-1"] });
    }
  });

  it("checks every owner of a workspace with several", async () => {
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string; userId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [OWNER, { userId: "owner-2", user: { email: "two@example.com", emailVerifiedAt: LONG_AGO, createdAt: LONG_AGO } }]
          : [{ workspace: { id: where.userId === "owner-2" ? "ws-9" : "ws-1" } }],
      ),
    );
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: { in: string[] } } }) =>
      Promise.resolve(where.workspaceId?.in.includes("ws-9") ? 30 : 0),
    );
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
  });

  it("with billing on, counts only the owner's workspaces not on a running plan, and none for a paying workspace", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [OWNER]
          : [
              { workspace: { id: "ws-1", ...TRIAL } },
              { workspace: { id: "ws-paid", ...PAID } },
            ],
      ),
    );

    await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: TRIAL, day: NOW, mode: "now" });
    expect(db.memberFindMany).toHaveBeenCalledWith({
      where: { userId: "owner-1", role: "owner" },
      select: {
        workspace: {
          select: {
            id: true,
            billingExempt: true,
            plan: true,
            planStatus: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
          },
        },
      },
    });
    expect(db.postJobCount).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1"] }, ...postsOnDay } });

    db.memberFindMany.mockClear();
    db.postJobCount.mockClear();
    await crossWorkspacePostRefusal({ workspaceId: "ws-paid", workspace: PAID, day: NOW, mode: "now" });
    // Only the owners' operator check: a paying workspace has neither a
    // per-person count nor the service's cap (review), only its plan's limits.
    expect(db.memberFindMany).toHaveBeenCalledTimes(1);
    expect(db.postJobCount).not.toHaveBeenCalled();
  });
});

// Review: the cap protects the Inngest budget from free use only. One rule,
// serviceCapApplies (planState and the operator check, in code), decides each
// workspace both for the refusal and for what is counted.
const VERIFIED = new Date("2026-10-01T00:00:00Z");
const OPS_OWNER = { user: { email: "ops@example.com", emailVerifiedAt: VERIFIED } };
const PLAIN_OWNER = { user: { email: "owner@example.com", emailVerifiedAt: VERIFIED } };

describe("serviceCapApplies: every plan state", () => {
  const DAYS = (n: number) => new Date(NOW.getTime() + n * DAY);
  const plan = (overrides: Record<string, unknown>) => ({ billingExempt: false, plan: "starter", ...overrides });

  it.each([
    ["trial", { billingExempt: false, trialEndsAt: DAYS(5) }, true],
    ["active plan", plan({ planStatus: "active", currentPeriodEnd: DAYS(20) }), false],
    ["trialing plan", plan({ planStatus: "trialing", currentPeriodEnd: DAYS(20) }), false],
    ["past_due within the grace", plan({ planStatus: "past_due", currentPeriodEnd: DAYS(-3) }), false],
    ["past_due after the grace", plan({ planStatus: "past_due", currentPeriodEnd: DAYS(-8) }), true],
    ["set to cancel at the period end, still active", plan({ planStatus: "active", currentPeriodEnd: DAYS(10) }), false],
    ["ended plan", plan({ planStatus: "canceled", currentPeriodEnd: DAYS(-1) }), true],
    ["ended trial", { billingExempt: false, trialEndsAt: DAYS(-1) }, true],
    ["exempt by flag (grandfathered)", { billingExempt: true }, false],
    ["exempt by flag, even with a plan that ended", plan({ billingExempt: true, planStatus: "canceled" }), false],
    ["plan set with no status", plan({ planStatus: null }), true],
    ["past_due with no period end", plan({ planStatus: "past_due", currentPeriodEnd: null }), true],
    ["no plan and no trial (made with billing off)", { billingExempt: false }, true],
  ])("billing on, %s: applies = %s", (_name, workspace, applies) => {
    expect(serviceCapApplies(workspace, false, NOW, { BILLING_ENABLED: "true" })).toBe(applies);
  });

  it("billing off: applies to every workspace but a grandfathered one", () => {
    expect(serviceCapApplies(plan({ planStatus: "active" }), false, NOW, {})).toBe(true);
    expect(serviceCapApplies({ billingExempt: false }, false, NOW, {})).toBe(true);
    expect(serviceCapApplies({ billingExempt: true }, false, NOW, {})).toBe(false);
  });

  it("never applies to a workspace an operator owns", () => {
    expect(serviceCapApplies({ billingExempt: false, trialEndsAt: DAYS(5) }, true, NOW, { BILLING_ENABLED: "true" })).toBe(false);
    expect(serviceCapApplies({ billingExempt: false }, true, NOW, {})).toBe(false);
  });
});

describe("the service's daily post cap", () => {
  /** The day's posts per workspace, and each workspace's plan columns and owners. */
  function day(rows: Array<{ id: string; posts: number; fields?: Record<string, unknown>; owners?: unknown[] }>) {
    db.postJobGroupBy.mockResolvedValue(rows.map((row) => ({ workspaceId: row.id, _count: { _all: row.posts } })));
    db.workspaceFindMany.mockResolvedValue(
      rows.map((row) => ({ id: row.id, billingExempt: false, ...row.fields, members: row.owners ?? [PLAIN_OWNER] })),
    );
  }

  it("groups the day's posts by workspace, then decides each workspace in code", async () => {
    day([{ id: "ws-free", posts: 3 }]);
    await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now", excludePostJobId: "job-9" });

    expect(db.postJobGroupBy).toHaveBeenCalledWith({
      by: ["workspaceId"],
      where: { ...sentOnDay, id: { not: "job-9" } },
      _count: { _all: true },
    });
    expect(db.eventGroupBy).toHaveBeenCalledWith({
      by: ["workspaceId"],
      where: { kind: "retry", at: { gte: DAY_START, lt: DAY_END } },
      _count: { _all: true },
    });
    expect(db.workspaceFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["ws-free"] } },
      select: {
        id: true,
        billingExempt: true,
        plan: true,
        planStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        members: { where: { role: "owner" }, select: { user: { select: { email: true, emailVerifiedAt: true } } } },
      },
    });
  });

  it("counts only the workspaces the cap applies to, plus the logged posts of deleted ones", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.workspaceFindUnique.mockResolvedValue({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + 5 * DAY) });
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 0 : 9));
    day([
      { id: "ws-free", posts: 30, fields: { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) } },
      { id: "ws-paid", posts: 400, fields: { plan: "pro", planStatus: "active" } },
      { id: "ws-old", posts: 300, fields: { billingExempt: true } },
      { id: "ws-ops", posts: 300, owners: [OPS_OWNER] },
    ]);

    // 30 + 9 logged = 39: one more fits.
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: TRIAL, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.eventCount).toHaveBeenCalledWith({ where: { kind: "post", at: { gte: DAY_START, lt: DAY_END } } });
  });

  it("refuses a free workspace at 40, with a sentence that says the service's daily limit was reached", async () => {
    day([{ id: "ws-free", posts: 31 }]);
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown } }) => Promise.resolve(where.OR ? 0 : 9));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" }),
    ).resolves.toEqual({
      code: "SERVICE_DAILY_POST_LIMIT",
      error: "That day is full: Vibe Socials has reached its daily limit of posts for the whole service. Pick another day.",
    });
  });

  // Review case: two free accounts filling a day cannot block a paying,
  // grandfathered or operator workspace.
  it("two free accounts filling the day block neither a paying nor a grandfathered workspace", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    day([
      { id: "ws-free-a", posts: 20 },
      { id: "ws-free-b", posts: 20 },
    ]);
    db.workspaceFindUnique.mockResolvedValueOnce({ billingExempt: false, plan: "pro", planStatus: "active" });
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-paid", workspace: PAID, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    db.workspaceFindUnique.mockResolvedValueOnce({ billingExempt: true });
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-old", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    // The cap's own workspaces are refused.
    db.workspaceFindUnique.mockResolvedValueOnce({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + 5 * DAY) });
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-free-c", workspace: TRIAL, day: NOW, mode: "now" }))?.code,
    ).toBe("SERVICE_DAILY_POST_LIMIT");
  });

  it("reads the posting workspace's own flag even with billing off, where the plan columns are not loaded", async () => {
    db.workspaceFindUnique.mockResolvedValue({ billingExempt: true });
    day([{ id: "ws-free", posts: 500 }]);
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-old", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.workspaceFindUnique).toHaveBeenCalledWith({
      where: { id: "ws-old" },
      select: { billingExempt: true, plan: true, planStatus: true, trialEndsAt: true, currentPeriodEnd: true },
    });
    expect(db.postJobGroupBy).not.toHaveBeenCalled();
  });

  it("never refuses a workspace the operator owns, and counts nothing for it", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: "ops-1", user: { email: "Ops@Example.com", emailVerifiedAt: VERIFIED, createdAt: VERIFIED } },
    ]);
    day([{ id: "ws-free", posts: 500 }]);

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-ops", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.postJobGroupBy).not.toHaveBeenCalled();
  });

  it("an unverified address on the operator list is not the operator", async () => {
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [{ userId: "x-1", user: { email: "ops@example.com", emailVerifiedAt: null, createdAt: LONG_AGO } }]
          : [],
      ),
    );
    day([{ id: "ws-free", posts: 40 }]);
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" });
    expect(refusal?.code).toBe("SERVICE_DAILY_POST_LIMIT");
  });

  it("with no post on the day, reads no workspace", async () => {
    day([]);
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.workspaceFindMany).not.toHaveBeenCalled();
  });
});

// R6-security M2 / new-customer M1: the per-person total covers every
// workspace the service's cap counts, with a smaller share for new accounts.
describe("the per-person total: which workspaces, and how many posts", () => {
  it("with billing on, counts a workspace made while billing was off (no plan, no trial)", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [OWNER]
          : [
              { workspace: { id: "ws-old-free", billingExempt: false } },
              { workspace: { id: "ws-paid", ...PAID } },
            ],
      ),
    );
    db.postJobCount.mockResolvedValue(30);
    const refusal = await crossWorkspacePostRefusal({
      workspaceId: "ws-old-free",
      workspace: { billingExempt: false },
      day: NOW,
      mode: "now",
    });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
    expect(db.postJobCount).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-old-free"] }, ...postsOnDay } });
  });

  it("an owner whose email is not confirmed gets 5 a day, and is told how it rises", async () => {
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [{ userId: "owner-1", user: { email: "new@example.com", emailVerifiedAt: null, createdAt: LONG_AGO } }]
          : [{ workspace: { id: "ws-1" } }],
      ),
    );
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 4 : 0),
    );
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 5 : 0),
    );
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow. The limit is 30 once the owner has confirmed their email address and the account is a day old.",
    });
    expect(db.memberFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { userId: true, user: { select: { email: true, emailVerifiedAt: true, createdAt: true } } },
    });
  });

  it("an account made less than a day ago gets 5 a day too", async () => {
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId
          ? [{ userId: "owner-1", user: { email: "new@example.com", emailVerifiedAt: NOW, createdAt: new Date(NOW.getTime() - 3_600_000) } }]
          : [{ workspace: { id: "ws-1" } }],
      ),
    );
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 5 : 0),
    );
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
  });
});

// R6-security M2: posts scheduled far ahead cannot fill a day of the service's cap.
describe("the service's cap counts posts as they are sent", () => {
  function sent(rows: Array<{ id: string; posts: number; retries?: number; fields?: Record<string, unknown>; missing?: boolean }>) {
    db.postJobGroupBy.mockResolvedValue(
      rows.filter((row) => row.posts > 0).map((row) => ({ workspaceId: row.id, _count: { _all: row.posts } })),
    );
    db.eventGroupBy.mockResolvedValue(
      rows.filter((row) => row.retries).map((row) => ({ workspaceId: row.id, _count: { _all: row.retries } })),
    );
    db.workspaceFindMany.mockResolvedValue(
      rows
        .filter((row) => !row.missing)
        .map((row) => ({ id: row.id, billingExempt: false, ...row.fields, members: [PLAIN_OWNER] })),
    );
  }

  it("scheduling for a future day is never refused by it: nothing has been sent that day", async () => {
    sent([]);
    const future = new Date("2027-03-01T12:00:00Z");
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: future, mode: "schedule", alsoOnDay: 20 }),
    ).resolves.toBeNull();
    const [args] = db.postJobGroupBy.mock.calls[0];
    expect(args.where.status).toEqual({ notIn: ["draft", "cancelled", "scheduled"] });
    expect(args.where.results).toEqual({ some: {} });
  });

  it("a post going out now counts itself and the request's other half; a scheduled one only what went out", async () => {
    sent([{ id: "ws-free", posts: 39 }]);
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now", alsoOnDay: 1 }))?.code,
    ).toBe("SERVICE_DAILY_POST_LIMIT");
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule", alsoOnDay: 1 }),
    ).resolves.toBeNull();
  });

  it("counts the retries of capped and deleted workspaces, never a paying or operator one's", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.workspaceFindUnique.mockResolvedValue({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + 5 * DAY) });
    sent([
      { id: "ws-free", posts: 30, retries: 5, fields: { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) } },
      { id: "ws-paid", posts: 100, retries: 100, fields: { plan: "pro", planStatus: "active" } },
      { id: "ws-gone", posts: 0, retries: 4, missing: true },
    ]);
    // 30 + 5 + 4 = 39: one more fits; one more retry anywhere and it is full.
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: TRIAL, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.workspaceFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["ws-free", "ws-paid", "ws-gone"] } });
    sent([
      { id: "ws-free", posts: 30, retries: 6, fields: { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) } },
      { id: "ws-gone", posts: 0, retries: 4, missing: true },
    ]);
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: TRIAL, day: NOW, mode: "retry" }))?.error,
    ).toBe("Vibe Socials has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.");
  });
});

describe("serviceCapRefusalAtSend: a scheduled post meets the cap when it is due", () => {
  it("refuses a free workspace's post once the day's sent posts reach the cap, not counting itself", async () => {
    db.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-free", _count: { _all: 40 } }]);
    db.workspaceFindMany.mockResolvedValue([{ id: "ws-free", billingExempt: false, members: [PLAIN_OWNER] }]);
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toEqual({
      errorCode: "SERVICE_DAILY_POST_LIMIT",
      errorMessage:
        "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.",
    });
    expect(db.postJobGroupBy.mock.calls[0][0].where).toEqual({ ...sentOnDay, id: { not: "job-1" } });
  });

  it("sends below the cap", async () => {
    db.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-free", _count: { _all: 39 } }]);
    db.workspaceFindMany.mockResolvedValue([{ id: "ws-free", billingExempt: false, members: [PLAIN_OWNER] }]);
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toBeNull();
  });

  it("never refuses, and counts nothing for, an operator's or a paying workspace", async () => {
    db.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-free", _count: { _all: 400 } }]);
    db.workspaceFindMany.mockResolvedValue([{ id: "ws-free", billingExempt: false, members: [PLAIN_OWNER] }]);
    db.memberFindMany.mockResolvedValueOnce([{ userId: "ops-1", user: { email: "ops@example.com", emailVerifiedAt: VERIFIED } }]);
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-ops", postJobId: "job-1", now: NOW })).resolves.toBeNull();

    vi.stubEnv("BILLING_ENABLED", "true");
    db.workspaceFindUnique.mockResolvedValueOnce({ billingExempt: false, plan: "pro", planStatus: "active" });
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-paid", postJobId: "job-2", now: NOW })).resolves.toBeNull();
    expect(db.postJobGroupBy).not.toHaveBeenCalled();
  });

  it("fails open: a read error logs and sends", async () => {
    db.memberFindMany.mockRejectedValue(new Error("db down"));
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toBeNull();
  });
});

// R6-security M3: retries cost executions like posts.
describe("retries: per post, and counted with the post caps", () => {
  it("allows the third retry of a post today and refuses the fourth", async () => {
    db.eventCount.mockImplementation(({ where }: { where: { sourceId?: unknown } }) =>
      Promise.resolve(where.sourceId ? 2 : 0),
    );
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toBeNull();
    expect(db.eventCount).toHaveBeenCalledWith({
      where: {
        kind: "retry",
        workspaceId: "ws-1",
        sourceId: { startsWith: "retry:job-1:" },
        at: { gte: DAY_START, lt: DAY_END },
      },
    });

    db.eventCount.mockImplementation(({ where }: { where: { sourceId?: unknown } }) =>
      Promise.resolve(where.sourceId ? 3 : 0),
    );
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toEqual({
      code: "POST_RETRY_LIMIT",
      error: "This post has been retried 3 times today, the most for one day. Retry it again tomorrow.",
    });
  });

  it("refuses a retry once the owner's posts and retries reach the per-person total", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 20 : 0),
    );
    db.eventCount.mockImplementation(({ where }: { where: { OR?: unknown; sourceId?: unknown } }) =>
      Promise.resolve(where.OR ? 10 : 0),
    );
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 30 posts a day across all the workspaces they own, and retries count toward it. Retry tomorrow.",
    });
  });

  it("refuses a retry once the service's cap is reached", async () => {
    db.postJobGroupBy.mockResolvedValue([{ workspaceId: "ws-free", _count: { _all: 40 } }]);
    db.workspaceFindMany.mockResolvedValue([{ id: "ws-free", billingExempt: false, members: [PLAIN_OWNER] }]);
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "job-1", now: NOW }))?.code).toBe(
      "SERVICE_DAILY_POST_LIMIT",
    );
  });

  it("never refuses the operator's retries", async () => {
    db.memberFindMany.mockResolvedValue([{ userId: "ops-1", user: { email: "ops@example.com", emailVerifiedAt: VERIFIED } }]);
    db.eventCount.mockResolvedValue(50);
    await expect(retryRefusal({ workspaceId: "ws-ops", postJobId: "job-1", now: NOW })).resolves.toBeNull();
  });

  it("fails open on a read error", async () => {
    db.eventCount.mockRejectedValue(new Error("db down"));
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "job-1", now: NOW })).resolves.toBeNull();
  });

  it("records each retry once, by request, and never throws", async () => {
    db.eventCreate.mockResolvedValue({});
    await recordRetry({ workspaceId: "ws-1", postJobId: "job-1", requestId: "req-1", at: NOW });
    expect(db.eventCreate).toHaveBeenCalledWith({
      data: { kind: "retry", workspaceId: "ws-1", sourceId: "retry:job-1:req-1", at: NOW },
    });
    db.eventCreate.mockRejectedValue(new Error("db down"));
    await expect(recordRetry({ workspaceId: "ws-1", postJobId: "job-1", requestId: "req-2", at: NOW })).resolves.toBeUndefined();
  });
});

describe("X posts per X account per month", () => {
  // The rows are written by the publish step with each X success
  // (resultClaim.usage.test.ts); the check only reads.
  it("counts the account's logged posts from every workspace and this workspace's, each once, and writes nothing", async () => {
    db.queryRaw.mockResolvedValue([{ count: 31 }]);

    await expect(xPostsThisMonth("ws-1", NOW)).resolves.toBe(31);

    expect(db.connectionFindUnique).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "x" } },
      select: { accountIdentifier: true },
    });
    expect(db.resultFindMany).not.toHaveBeenCalled();
    expect(db.eventCreateMany).not.toHaveBeenCalled();
    // One count of distinct posts: the log (account or workspace) and the live results, by source id.
    const [strings, ...values] = db.queryRaw.mock.calls[0];
    const sql = (strings as string[]).join("?");
    expect(sql).toContain('FROM "UsageEvent"');
    expect(sql).toContain("UNION");
    expect(sql).toContain('FROM "PostJobResult"');
    expect(sql).toContain('"accountIdentifier"');
    // R6-publishing: the month's start is bound as UTC, like the scanner, so
    // the boundary never depends on the database session's time zone.
    expect(sql).toContain(`"at" >= ?::timestamptz AT TIME ZONE 'UTC'`);
    expect(sql).toContain(`r."updatedAt" >= ?::timestamptz AT TIME ZONE 'UTC'`);
    expect(values).toEqual([MONTH_START, "ws-1", "x-account-7", MONTH_START, "ws-1", "x-account-7"]);
  });

  // Review case: publish in W1, disconnect, connect the same X account in W2.
  // W1's posts were logged with the account at publish, so W2's count, which
  // asks the log by account, includes them; the live connection is not needed.
  it("in a second workspace with the same X account, counts the first workspace's logged posts by account", async () => {
    db.connectionFindUnique.mockResolvedValue({ accountIdentifier: "x-account-7" });
    db.queryRaw.mockResolvedValue([{ count: BigInt(30) }]);

    await expect(xPostsThisMonth("ws-2", NOW)).resolves.toBe(30);

    const [strings, ...values] = db.queryRaw.mock.calls[0];
    expect((strings as string[]).join("?")).toContain('("workspaceId" = ? OR "accountId" = ?)');
    expect(values.slice(0, 3)).toEqual([MONTH_START, "ws-2", "x-account-7"]);
  });

  it("with no X connection, counts the workspace's own posts only", async () => {
    db.connectionFindUnique.mockResolvedValue(null);
    await xPostsThisMonth("ws-1", NOW);
    const [, ...values] = db.queryRaw.mock.calls[0];
    expect(values).toEqual([MONTH_START, "ws-1", null, MONTH_START, "ws-1", null]);
  });
});

describe("before a workspace is deleted", () => {
  it("copies today's posts that went out and this month's X posts, in the deleting transaction", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn(), deleteMany: vi.fn() },
      postJob: {
        findMany: vi.fn().mockResolvedValue([
          { id: "job-1", workspaceId: "ws-gone", scheduledFor: null, createdAt: new Date("2026-11-14T09:00:00Z") },
          { id: "job-2", workspaceId: "ws-gone", scheduledFor: new Date("2026-11-14T08:00:00Z"), createdAt: new Date("2026-11-10T09:00:00Z") },
        ]),
      },
      postJobResult: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "result-9",
            updatedAt: new Date("2026-11-02T10:00:00Z"),
            postJob: { workspaceId: "ws-gone", userId: "owner-1" },
            socialConnection: { accountIdentifier: "x-account-7" },
          },
        ]),
      },
      workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws-gone", members: [PLAIN_OWNER] }]) },
    };

    await copyUsageBeforeDeletion(tx as never, { workspaceIds: ["ws-gone"], userId: "owner-1", now: NOW });

    expect(tx.postJob.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: { in: ["ws-gone"] },
        status: { notIn: ["draft", "cancelled", "scheduled"] },
        OR: postsOnDay.OR,
      },
      select: { id: true, workspaceId: true, scheduledFor: true, createdAt: true },
    });
    expect(tx.usageEvent.createMany).toHaveBeenCalledWith({
      data: [
        { kind: "post", userId: "owner-1", workspaceId: "ws-gone", sourceId: "job-1", at: new Date("2026-11-14T09:00:00Z") },
        { kind: "post", userId: "owner-1", workspaceId: "ws-gone", sourceId: "job-2", at: new Date("2026-11-14T08:00:00Z") },
      ],
      skipDuplicates: true,
    });
    expect(tx.usageEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          kind: "x_post",
          userId: "owner-1",
          workspaceId: "ws-gone",
          platform: "x",
          accountId: "x-account-7",
          sourceId: "result-9",
          at: new Date("2026-11-02T10:00:00Z"),
        },
      ],
      skipDuplicates: true,
    });
    // Nothing reaches the default client: it all happens inside the transaction.
    expect(prisma.usageEvent.createMany).not.toHaveBeenCalled();
    // R6-security M3: today's retries keep counting toward the deleting owner.
    expect(tx.usageEvent.updateMany).toHaveBeenCalledWith({
      where: { kind: "retry", workspaceId: { in: ["ws-gone"] }, at: { gte: DAY_START, lt: DAY_END } },
      data: { userId: "owner-1" },
    });
    expect(tx.usageEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("with billing on, a paying workspace's posts are not copied: they count toward no free limit", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn(), deleteMany: vi.fn() },
      postJob: {
        // Answers as the database would: only the asked workspaces' posts.
        findMany: vi.fn(async ({ where }: { where: { workspaceId: { in: string[] } } }) =>
          [
            { id: "job-1", workspaceId: "ws-paid", scheduledFor: null, createdAt: new Date("2026-11-14T09:00:00Z") },
            { id: "job-2", workspaceId: "ws-trial", scheduledFor: null, createdAt: new Date("2026-11-14T10:00:00Z") },
          ].filter((post) => where.workspaceId.in.includes(post.workspaceId)),
        ),
      },
      postJobResult: { findMany: vi.fn().mockResolvedValue([]) },
      workspace: {
        findMany: vi.fn().mockResolvedValue([
          { id: "ws-paid", ...PAID, members: [PLAIN_OWNER] },
          { id: "ws-trial", ...TRIAL, members: [PLAIN_OWNER] },
        ]),
      },
    };

    await copyUsageBeforeDeletion(tx as never, {
      workspaceIds: ["ws-paid", "ws-trial"],
      userId: "owner-1",
      now: NOW,
    });

    expect(tx.usageEvent.createMany).toHaveBeenCalledTimes(1);
    expect(tx.usageEvent.createMany.mock.calls[0][0].data).toEqual([
      { kind: "post", userId: "owner-1", workspaceId: "ws-trial", sourceId: "job-2", at: new Date("2026-11-14T10:00:00Z") },
    ]);
    // A paying workspace's retries count toward no free limit, so they go with it;
    // the trial's stay, now counted toward the deleting owner.
    expect(tx.usageEvent.deleteMany).toHaveBeenCalledWith({ where: { kind: "retry", workspaceId: { in: ["ws-paid"] } } });
    expect(tx.usageEvent.updateMany).toHaveBeenCalledWith({
      where: { kind: "retry", workspaceId: { in: ["ws-trial"] }, at: { gte: DAY_START, lt: DAY_END } },
      data: { userId: "owner-1" },
    });
  });

  // Review decision: grandfathered workspaces are outside the cap, so their posts are not copied.
  it("a grandfathered workspace's posts are not copied, with billing off too", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn(), deleteMany: vi.fn() },
      postJob: { findMany: vi.fn().mockResolvedValue([]) },
      postJobResult: { findMany: vi.fn().mockResolvedValue([]) },
      workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws-old", billingExempt: true, members: [PLAIN_OWNER] }]) },
    };
    await copyUsageBeforeDeletion(tx as never, { workspaceIds: ["ws-old"], userId: "owner-1", now: NOW });
    expect(tx.workspace.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["ws-old"] } },
      select: {
        id: true,
        billingExempt: true,
        plan: true,
        planStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        members: { where: { role: "owner" }, select: { user: { select: { email: true, emailVerifiedAt: true } } } },
      },
    });
    expect(tx.postJob.findMany).not.toHaveBeenCalled();
    expect(tx.usageEvent.createMany).not.toHaveBeenCalled();
  });

  // Third review case: a customer owner deletes a workspace the operator also
  // owns. The workspace's own owners decide, not the deleting person.
  it("a workspace an operator also owns copies no posts, whoever deletes it; only X posts", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }), updateMany: vi.fn(), deleteMany: vi.fn() },
      postJob: {
        findMany: vi.fn().mockResolvedValue([
          { id: "job-1", workspaceId: "ws-ops", scheduledFor: null, createdAt: new Date("2026-11-14T09:00:00Z") },
        ]),
      },
      postJobResult: { findMany: vi.fn().mockResolvedValue([]) },
      workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws-ops", members: [PLAIN_OWNER, OPS_OWNER] }]) },
    };
    await copyUsageBeforeDeletion(tx as never, { workspaceIds: ["ws-ops"], userId: "owner-1", now: NOW });
    expect(tx.postJob.findMany).not.toHaveBeenCalled();
    expect(tx.usageEvent.createMany).not.toHaveBeenCalled();
    expect(tx.postJobResult.findMany).toHaveBeenCalled();
    expect(tx.usageEvent.deleteMany).toHaveBeenCalledWith({ where: { kind: "retry", workspaceId: { in: ["ws-ops"] } } });
    expect(tx.usageEvent.updateMany).not.toHaveBeenCalled();
  });

  it("writes nothing when nothing counted today or this month", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
      postJob: { findMany: vi.fn().mockResolvedValue([]) },
      postJobResult: { findMany: vi.fn().mockResolvedValue([]) },
      workspace: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await copyUsageBeforeDeletion(tx as never, { workspaceIds: ["ws-gone"], userId: "owner-1", now: NOW });
    expect(tx.usageEvent.createMany).not.toHaveBeenCalled();
  });
});

describe("workspaces created per person", () => {
  it("records a creation, once per workspace", async () => {
    const tx = { usageEvent: { create: vi.fn().mockResolvedValue({}) } };
    await recordWorkspaceCreated(tx as never, { userId: "user-1", workspaceId: "ws-new", at: NOW });
    expect(tx.usageEvent.create).toHaveBeenCalledWith({
      data: {
        kind: "workspace_created",
        userId: "user-1",
        workspaceId: "ws-new",
        sourceId: "workspace_created:ws-new",
        at: NOW,
      },
    });
  });

  it("allows the 30th creation in 30 days, deleted workspaces included", async () => {
    db.eventFindMany.mockResolvedValue(Array.from({ length: 29 }, (_, i) => ({ at: new Date(NOW.getTime() - i * DAY) })));
    await expect(workspaceCreationRefusal("user-1", NOW)).resolves.toBeNull();
    expect(db.eventFindMany).toHaveBeenCalledWith({
      where: { kind: "workspace_created", userId: "user-1", at: { gt: new Date(NOW.getTime() - 30 * DAY) } },
      select: { at: true },
      orderBy: { at: "asc" },
    });
  });

  it("refuses the 31st, naming the day the oldest leaves the window", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ at: new Date(NOW.getTime() - (29 - i) * DAY + 60_000) }));
    db.eventFindMany.mockResolvedValue(rows);
    await expect(workspaceCreationRefusal("user-1", NOW)).resolves.toEqual({
      code: "WORKSPACE_CREATION_LIMIT",
      error:
        "You have created 30 workspaces in the last 30 days, the most allowed. Deleted workspaces count too. You can create another from 15 November 2026.",
    });
  });

  it("fails open when the log cannot be read", async () => {
    db.eventFindMany.mockRejectedValue(new Error("db down"));
    await expect(workspaceCreationRefusal("user-1", NOW)).resolves.toBeNull();
  });
});

// Review: the log keeps only what a limit can still count.
describe("pruneUsageEvents", () => {
  it("deletes rows older than the longest window any limit counts, with room (62 days)", async () => {
    db.eventDeleteMany.mockResolvedValue({ count: 5 });
    expect(USAGE_EVENT_RETENTION_DAYS).toBe(62);
    await expect(pruneUsageEvents(NOW)).resolves.toBe(5);
    expect(db.eventDeleteMany).toHaveBeenCalledWith({ where: { at: { lt: new Date(NOW.getTime() - 62 * DAY) } } });
  });

  it("never throws: a failure is logged and reported as none pruned", async () => {
    db.eventDeleteMany.mockRejectedValue(new Error("db down"));
    await expect(pruneUsageEvents(NOW)).resolves.toBe(0);
  });
});
