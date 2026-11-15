import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventCreateMany: vi.fn(),
  eventCount: vi.fn(),
  eventFindMany: vi.fn(),
  postJobCount: vi.fn(),
  postJobFindMany: vi.fn(),
  resultFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  workspaceFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    usageEvent: { create: db.eventCreate, createMany: db.eventCreateMany, count: db.eventCount, findMany: db.eventFindMany },
    postJob: { count: db.postJobCount, findMany: db.postJobFindMany },
    postJobResult: { findMany: db.resultFindMany },
    workspaceMember: { findMany: db.memberFindMany },
    workspace: { findMany: db.workspaceFindMany },
    socialConnection: { findUnique: db.connectionFindUnique },
    $queryRaw: db.queryRaw,
  },
}));

import { prisma } from "@/lib/db";

import {
  copyUsageBeforeDeletion,
  crossWorkspacePostRefusal,
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

const OWNER = { userId: "owner-1", user: { email: "owner@example.com", emailVerifiedAt: new Date("2026-10-01T00:00:00Z") } };
const TRIAL = { billingExempt: false, trialEndsAt: new Date("2026-11-20T00:00:00Z") };
const PAID = { billingExempt: false, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2026-12-10T00:00:00Z") };

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
  db.eventCount.mockResolvedValue(0);
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
  db.connectionFindUnique.mockResolvedValue({ accountIdentifier: "x-account-7" });
  db.queryRaw.mockResolvedValue([{ count: 0 }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
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

describe("posts per owner per day, across the workspaces they own", () => {
  it("counts the posts of every owned workspace and the owner's logged posts of deleted ones", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 40 : 0),
    );
    db.eventCount.mockImplementation(({ where }: { where: { userId?: string } }) => Promise.resolve(where.userId ? 19 : 0));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();

    expect(db.memberFindMany).toHaveBeenCalledWith({
      where: { userId: "owner-1", role: "owner" },
      select: { workspace: { select: { id: true } } },
    });
    expect(db.postJobCount).toHaveBeenCalledWith({ where: { workspaceId: { in: ["ws-1", "ws-2"] }, ...postsOnDay } });
    expect(db.eventCount).toHaveBeenCalledWith({
      where: { kind: "post", userId: "owner-1", at: { gte: DAY_START, lt: DAY_END } },
    });
  });

  it("refuses the post that would pass 60, with a sentence that says it is the owner's total", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 45 : 45),
    );
    db.eventCount.mockImplementation(({ where }: { where: { userId?: string } }) => Promise.resolve(where.userId ? 15 : 0));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 60 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
    });
  });

  it("a deleted workspace's posts still count: 0 live, 60 logged", async () => {
    db.eventCount.mockImplementation(({ where }: { where: { userId?: string } }) => Promise.resolve(where.userId ? 60 : 60));
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
  });

  it("adds the request's own posts and leaves out the posts being moved", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 59 : 59),
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
          ? [OWNER, { userId: "owner-2", user: { email: "two@example.com", emailVerifiedAt: null } }]
          : [{ workspace: { id: where.userId === "owner-2" ? "ws-9" : "ws-1" } }],
      ),
    );
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: { in: string[] } } }) =>
      Promise.resolve(where.workspaceId?.in.includes("ws-9") ? 60 : 0),
    );
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" });
    expect(refusal?.code).toBe("OWNER_DAILY_POST_LIMIT");
  });

  it("with billing on, counts only the owner's workspaces on a free trial, and none for a paying workspace", async () => {
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
    // Only the owners' operator check; no per-person count for a paying workspace.
    expect(db.memberFindMany).toHaveBeenCalledTimes(1);
    expect(db.postJobCount).toHaveBeenCalledTimes(1);
    expect(db.postJobCount.mock.calls[0][0].where.workspaceId).toBeUndefined();
  });
});

describe("the service's daily post cap", () => {
  it("counts every workspace's posts on the day plus the logged posts of deleted workspaces", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 0 : 70),
    );
    db.eventCount.mockImplementation(({ where }: { where: { userId?: string } }) => Promise.resolve(where.userId ? 0 : 9));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.postJobCount).toHaveBeenCalledWith({ where: postsOnDay });
    expect(db.eventCount).toHaveBeenCalledWith({ where: { kind: "post", at: { gte: DAY_START, lt: DAY_END } } });
  });

  it("refuses at 80 with a sentence that says the service's daily limit was reached", async () => {
    db.postJobCount.mockImplementation(({ where }: { where: { workspaceId?: unknown } }) =>
      Promise.resolve(where.workspaceId ? 0 : 71),
    );
    db.eventCount.mockImplementation(({ where }: { where: { userId?: string } }) => Promise.resolve(where.userId ? 0 : 9));

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" }),
    ).resolves.toEqual({
      code: "SERVICE_DAILY_POST_LIMIT",
      error: "That day is full: Vibe Socials has reached its daily limit of posts for the whole service. Pick another day.",
    });
  });

  it("never refuses a workspace the operator owns, and counts nothing for it", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: "ops-1", user: { email: "Ops@Example.com", emailVerifiedAt: new Date("2026-10-01T00:00:00Z") } },
    ]);
    db.postJobCount.mockResolvedValue(500);
    db.eventCount.mockResolvedValue(500);

    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-ops", workspace: {}, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(db.postJobCount).not.toHaveBeenCalled();
  });

  it("an unverified address on the operator list is not the operator", async () => {
    db.memberFindMany.mockImplementation(({ where }: { where: { workspaceId?: string } }) =>
      Promise.resolve(
        where.workspaceId ? [{ userId: "x-1", user: { email: "ops@example.com", emailVerifiedAt: null } }] : [],
      ),
    );
    db.postJobCount.mockResolvedValue(80);
    const refusal = await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" });
    expect(refusal?.code).toBe("SERVICE_DAILY_POST_LIMIT");
  });
});

describe("X posts per X account per month", () => {
  it("copies the workspace's X posts of the month into the log, then counts the account's and the workspace's", async () => {
    db.resultFindMany.mockResolvedValue([
      {
        id: "result-1",
        updatedAt: new Date("2026-11-03T10:00:00Z"),
        postJob: { workspaceId: "ws-1", userId: "user-1" },
        socialConnection: { accountIdentifier: "x-account-7" },
      },
      {
        id: "result-2",
        updatedAt: new Date("2026-11-04T10:00:00Z"),
        postJob: { workspaceId: "ws-1", userId: "user-1" },
        socialConnection: null,
      },
    ]);
    db.queryRaw.mockResolvedValue([{ count: 31 }]);

    await expect(xPostsThisMonth("ws-1", NOW, { copyToLog: true })).resolves.toBe(31);

    expect(db.connectionFindUnique).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "x" } },
      select: { accountIdentifier: true },
    });
    expect(db.resultFindMany).toHaveBeenCalledWith({
      where: { postJob: { workspaceId: { in: ["ws-1"] } }, platform: "x", status: "success", updatedAt: { gte: MONTH_START } },
      select: {
        id: true,
        updatedAt: true,
        postJob: { select: { workspaceId: true, userId: true } },
        socialConnection: { select: { accountIdentifier: true } },
      },
    });
    expect(db.eventCreateMany).toHaveBeenCalledWith({
      data: [
        {
          kind: "x_post",
          userId: "user-1",
          workspaceId: "ws-1",
          platform: "x",
          accountId: "x-account-7",
          sourceId: "result-1",
          at: new Date("2026-11-03T10:00:00Z"),
        },
        {
          kind: "x_post",
          userId: "user-1",
          workspaceId: "ws-1",
          platform: "x",
          accountId: null,
          sourceId: "result-2",
          at: new Date("2026-11-04T10:00:00Z"),
        },
      ],
      skipDuplicates: true,
    });
    // One count of distinct posts: the log (account or workspace) and the live results, by source id.
    const [strings, ...values] = db.queryRaw.mock.calls[0];
    const sql = (strings as string[]).join("?");
    expect(sql).toContain('FROM "UsageEvent"');
    expect(sql).toContain("UNION");
    expect(sql).toContain('FROM "PostJobResult"');
    expect(sql).toContain('"accountIdentifier"');
    expect(values).toEqual([MONTH_START, "ws-1", "x-account-7", MONTH_START, "ws-1", "x-account-7"]);
  });

  it("only counts, writing nothing, when asked for Settings", async () => {
    db.queryRaw.mockResolvedValue([{ count: BigInt(4) }]);
    await expect(xPostsThisMonth("ws-1", NOW, { copyToLog: false })).resolves.toBe(4);
    expect(db.resultFindMany).not.toHaveBeenCalled();
    expect(db.eventCreateMany).not.toHaveBeenCalled();
  });

  it("with no X connection, counts the workspace's own posts only", async () => {
    db.connectionFindUnique.mockResolvedValue(null);
    await xPostsThisMonth("ws-1", NOW, { copyToLog: false });
    const [, ...values] = db.queryRaw.mock.calls[0];
    expect(values).toEqual([MONTH_START, "ws-1", null, MONTH_START, "ws-1", null]);
  });
});

describe("before a workspace is deleted", () => {
  it("copies today's posts that went out and this month's X posts, in the deleting transaction", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
      workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws-gone" }]) },
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
  });

  it("with billing on, a paying workspace's posts count for the service but for nobody's own total", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const tx = {
      usageEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      postJob: {
        findMany: vi.fn().mockResolvedValue([
          { id: "job-1", workspaceId: "ws-paid", scheduledFor: null, createdAt: new Date("2026-11-14T09:00:00Z") },
          { id: "job-2", workspaceId: "ws-trial", scheduledFor: null, createdAt: new Date("2026-11-14T10:00:00Z") },
        ]),
      },
      postJobResult: { findMany: vi.fn().mockResolvedValue([]) },
      workspace: {
        findMany: vi.fn().mockResolvedValue([
          { id: "ws-paid", ...PAID },
          { id: "ws-trial", ...TRIAL },
        ]),
      },
    };

    await copyUsageBeforeDeletion(tx as never, { workspaceIds: ["ws-paid", "ws-trial"], userId: "owner-1", now: NOW });

    expect(tx.usageEvent.createMany).toHaveBeenCalledTimes(1);
    expect(tx.usageEvent.createMany.mock.calls[0][0].data).toEqual([
      { kind: "post", userId: null, workspaceId: "ws-paid", sourceId: "job-1", at: new Date("2026-11-14T09:00:00Z") },
      { kind: "post", userId: "owner-1", workspaceId: "ws-trial", sourceId: "job-2", at: new Date("2026-11-14T10:00:00Z") },
    ]);
  });

  it("writes nothing when nothing counted today or this month", async () => {
    const tx = {
      usageEvent: { createMany: vi.fn() },
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
