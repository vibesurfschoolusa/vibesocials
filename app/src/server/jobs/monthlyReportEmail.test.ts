import { RetryAfterError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory Workspace table behind the job's three workspace queries, so
// the selection, the marker and the continuation are tested as behaviour.
const m = vi.hoisted(() => ({
  workspaces: [] as { id: string; createdAt: Date; monthlyReportSentFor: string | null }[],
  owners: {} as Record<string, { userId: string; email: string; notifyMonthlyReport: boolean }[]>,
  links: new Set<string>(),
  buildMonthlyReport: vi.fn(),
  sendEmail: vi.fn(),
  memberFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  workspaceUpdateMany: vi.fn(),
  log: [] as string[],
}));

type Where = {
  OR?: ({ monthlyReportSentFor: null } | { monthlyReportSentFor: { not: string } })[];
  AND?: { OR: ({ createdAt: { gt: Date } } | { createdAt: Date; id: { gt: string } })[] }[];
};

function matches(row: (typeof m.workspaces)[number], where: Where): boolean {
  const marker = where.OR?.some((clause) =>
    clause.monthlyReportSentFor === null
      ? row.monthlyReportSentFor === null
      : row.monthlyReportSentFor !== null && row.monthlyReportSentFor !== clause.monthlyReportSentFor.not,
  );
  if (where.OR && !marker) return false;
  for (const and of where.AND ?? []) {
    const after = and.OR.some((clause) =>
      "id" in clause
        ? row.createdAt.getTime() === clause.createdAt.getTime() && row.id > clause.id.gt
        : row.createdAt > clause.createdAt.gt,
    );
    if (!after) return false;
  }
  return true;
}

function sorted() {
  return [...m.workspaces].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findMany: async ({ where, take }: { where: Where; take: number }) =>
        sorted()
          .filter((row) => matches(row, where))
          .slice(0, take)
          .map(({ id, createdAt }) => ({ id, createdAt })),
      count: async ({ where }: { where: Where }) => m.workspaces.filter((row) => matches(row, where)).length,
      updateMany: (...args: unknown[]) => m.workspaceUpdateMany(...args),
    },
    workspaceMember: { findMany: (...args: unknown[]) => m.memberFindMany(...args) },
    workspaceReviewLink: { findFirst: (...args: unknown[]) => m.linkFindFirst(...args) },
  },
}));
vi.mock("@/server/reports/monthlyReport", () => ({ buildMonthlyReport: m.buildMonthlyReport }));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: m.sendEmail,
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { MonthlyReport } from "@/lib/monthlyReport";
import { logger } from "@/lib/logger";
import { EmailRetryableError } from "@/server/notifications/email";

import {
  MONTHLY_REPORT_RUN_BUDGET_MS,
  MONTHLY_REPORT_SEND_INTERVAL_MS,
  monthJustEnded,
  runMonthlyReportEmails,
} from "./monthlyReportEmail";

const NOV_1 = new Date("2026-11-01T15:00:00Z");

function report(workspaceId: string, postCount = 3): MonthlyReport {
  return {
    month: "2026-10",
    workspaceName: `Name of ${workspaceId}`,
    logoUrl: null,
    inProgress: false,
    postCount,
    posts: [],
    totals: { resultsByPlatform: postCount ? [{ platform: "Instagram", count: postCount }] : [], numbers: [] },
    listing: null,
    failed: [],
  };
}

function addWorkspace(id: string, day: number, marker: string | null = null) {
  m.workspaces.push({ id, createdAt: new Date(Date.UTC(2026, 0, day)), monthlyReportSentFor: marker });
}

/** Owners of `id`, each "user-<id>-<n>" with an example.com address. */
function addOwners(id: string, count: number, notify = true) {
  m.owners[id] = Array.from({ length: count }, (_, n) => ({
    userId: `user-${id}-${n}`,
    email: `owner${n}@${id}.example.com`,
    notifyMonthlyReport: notify,
  }));
}

const sleep = vi.fn<(ms: number) => Promise<void>>();
const run = (now = NOV_1, clock?: () => number) => runMonthlyReportEmails({ now, sleep, clock });
const sentKeys = () => m.sendEmail.mock.calls.map((call) => call[1].idempotencyKey as string);

beforeEach(() => {
  m.workspaces.length = 0;
  m.owners = {};
  m.links.clear();
  m.log.length = 0;
  for (const fn of [m.buildMonthlyReport, m.sendEmail, m.memberFindMany, m.linkFindFirst, m.workspaceUpdateMany, sleep]) {
    fn.mockReset();
  }
  vi.mocked(logger.warn).mockReset();
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  sleep.mockResolvedValue(undefined);
  m.buildMonthlyReport.mockImplementation(async (id: string) => report(id));
  m.memberFindMany.mockImplementation(async ({ where }: { where: { workspaceId: string; user: { notifyMonthlyReport: boolean } } }) =>
    (m.owners[where.workspaceId] ?? [])
      .filter((owner) => owner.notifyMonthlyReport === where.user.notifyMonthlyReport)
      .map((owner) => ({ userId: owner.userId, user: { email: owner.email } })),
  );
  m.linkFindFirst.mockImplementation(async ({ where }: { where: { workspaceId: string } }) =>
    m.links.has(where.workspaceId) ? { id: "link-row" } : null,
  );
  m.sendEmail.mockImplementation(async ({ to }: { to: string }) => {
    m.log.push(`send ${to}`);
  });
  m.workspaceUpdateMany.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { monthlyReportSentFor: string } }) => {
      m.log.push(`mark ${where.id} ${data.monthlyReportSentFor}`);
      const row = m.workspaces.find((w) => w.id === where.id);
      if (row) row.monthlyReportSentFor = data.monthlyReportSentFor;
      return { count: row ? 1 : 0 };
    },
  );
});

describe("monthJustEnded", () => {
  it("is the month before the run's UTC month, across the year on 1 January", () => {
    expect(monthJustEnded(NOV_1)).toBe("2026-10");
    expect(monthJustEnded(new Date("2027-01-01T15:00:00Z"))).toBe("2026-12");
  });
});

describe("runMonthlyReportEmails", () => {
  it("handles only workspaces whose marker differs from the month just ended, oldest first", async () => {
    addWorkspace("ws-new", 3);
    addWorkspace("ws-done", 1, "2026-10");
    addWorkspace("ws-old", 2, "2026-09");
    addWorkspace("ws-never", 1);

    await run();

    expect(m.buildMonthlyReport.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["ws-never", "2026-10"],
      ["ws-old", "2026-10"],
      ["ws-new", "2026-10"],
    ]);
    expect(m.buildMonthlyReport.mock.calls[0][2]).toEqual(NOV_1);
  });

  it("builds the report for December of the year before on 1 January", async () => {
    addWorkspace("ws-1", 1, "2026-11");
    await run(new Date("2027-01-01T15:00:00Z"));
    expect(m.buildMonthlyReport).toHaveBeenCalledWith("ws-1", "2026-12", expect.any(Date));
    expect(m.workspaces[0].monthlyReportSentFor).toBe("2026-12");
  });

  it("writes the marker and sends nothing when nothing was published", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 2);
    m.buildMonthlyReport.mockResolvedValue(report("ws-1", 0));

    const result = await run();

    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.memberFindMany).not.toHaveBeenCalled();
    expect(m.log).toEqual(["mark ws-1 2026-10"]);
    expect(result).toMatchObject({ handled: 1, nothingToReport: 1, emailed: 0 });
  });

  it("emails each owner with the switch on once, with the (workspace, month, owner) key, then writes the marker", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 2);
    m.owners["ws-1"].push({ userId: "user-off", email: "off@ws-1.example.com", notifyMonthlyReport: false });

    const result = await run();

    expect(m.memberFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws-1",
      role: "owner",
      user: { notifyMonthlyReport: true },
    });
    expect(sentKeys()).toEqual(["monthly-report/ws-1/2026-10/user-ws-1-0", "monthly-report/ws-1/2026-10/user-ws-1-1"]);
    for (const call of m.sendEmail.mock.calls) expect(call[1].throwOnRetryable).toBe(true);
    expect(m.log).toEqual(["send owner0@ws-1.example.com", "send owner1@ws-1.example.com", "mark ws-1 2026-10"]);
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Name of ws-1: your report for October 2026");
    expect(m.sendEmail.mock.calls[0][0].html).toContain("https://app.example.com/reports?month=2026-10");
    expect(result).toMatchObject({ handled: 1, emailed: 2, failed: 0 });
  });

  it("paces the sends as the daily digest does", async () => {
    addWorkspace("ws-1", 1);
    addWorkspace("ws-2", 2);
    addOwners("ws-1", 2);
    addOwners("ws-2", 1);

    await run();

    // Three sends, a pause before each but the first.
    expect(sleep.mock.calls).toEqual([[MONTHLY_REPORT_SEND_INTERVAL_MS], [MONTHLY_REPORT_SEND_INTERVAL_MS]]);
    expect(MONTHLY_REPORT_SEND_INTERVAL_MS).toBe(600);
  });

  it("says the client can open it when a review link is on, reading only whether one is", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 1);
    m.links.add("ws-1");

    await run();

    expect(m.linkFindFirst.mock.calls[0][0]).toEqual({
      where: { workspaceId: "ws-1", revokedAt: null },
      select: { id: true },
    });
    const html: string = m.sendEmail.mock.calls[0][0].html;
    expect(html).toContain("Your client can open the same report from their review link.");
    expect(html).not.toContain("/v/");
  });

  it("retries a failed send once, then counts it, writes the marker and carries on", async () => {
    addWorkspace("ws-1", 1);
    addWorkspace("ws-2", 2);
    addOwners("ws-1", 1);
    addOwners("ws-2", 1);
    m.sendEmail.mockImplementation(async ({ to }: { to: string }) => {
      m.log.push(`send ${to}`);
      if (to.includes("ws-1")) throw new EmailRetryableError("down");
    });

    const result = await run();

    expect(m.log).toEqual([
      "send owner0@ws-1.example.com",
      "send owner0@ws-1.example.com",
      "mark ws-1 2026-10",
      "send owner0@ws-2.example.com",
      "mark ws-2 2026-10",
    ]);
    expect(result).toMatchObject({ handled: 2, emailed: 1, failed: 1 });
  });

  it("waits no longer than 2 s before the retry, whatever delay a rate limit asks for", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 1);
    m.sendEmail.mockRejectedValueOnce(new RetryAfterError("slow down", 60_000)).mockResolvedValueOnce(undefined);

    const result = await run();

    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.at(-1)?.[0]).toBeLessThanOrEqual(2_000);
    expect(result).toMatchObject({ emailed: 1, failed: 0 });
  });

  it("stops starting workspaces after 150 seconds; the next day's run carries on and the third logs the rest", async () => {
    for (let day = 1; day <= 3; day += 1) {
      addWorkspace(`ws-${day}`, day);
      addOwners(`ws-${day}`, 1);
    }
    // Each report takes 100 s of the run.
    let now = 0;
    const clock = () => now;
    m.buildMonthlyReport.mockImplementation(async (id: string) => {
      now += 100_000;
      return report(id);
    });

    const first = await run(NOV_1, clock);
    expect(m.buildMonthlyReport.mock.calls.map((call) => call[0])).toEqual(["ws-1", "ws-2"]);
    expect(first).toMatchObject({ handled: 2, left: 1 });
    expect(MONTHLY_REPORT_RUN_BUDGET_MS).toBe(150_000);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("skipped"), expect.anything());

    now = 0;
    m.buildMonthlyReport.mockClear();
    const second = await run(new Date("2026-11-02T15:00:00Z"), clock);
    expect(m.buildMonthlyReport.mock.calls.map((call) => call[0])).toEqual(["ws-3"]);
    expect(second).toMatchObject({ handled: 1, left: 0 });
  });

  it("logs a count of the workspaces the third run did not reach", async () => {
    addWorkspace("ws-1", 1);
    addWorkspace("ws-2", 2);
    let now = 0;
    m.buildMonthlyReport.mockImplementation(async (id: string) => {
      now += MONTHLY_REPORT_RUN_BUDGET_MS;
      return report(id, 0);
    });

    const result = await run(new Date("2026-11-03T15:00:00Z"), () => now);

    expect(result).toMatchObject({ handled: 1, left: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("skipped for the month"), { month: "2026-10", count: 1 });
  });

  it("sends nothing more on a second run in the same month", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 2);
    await run();
    m.sendEmail.mockClear();
    m.buildMonthlyReport.mockClear();

    const again = await run(new Date("2026-11-02T15:00:00Z"));

    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.buildMonthlyReport).not.toHaveBeenCalled();
    expect(again).toMatchObject({ handled: 0, emailed: 0 });
  });

  it("leaves a workspace whose report could not be built unmarked for the next run", async () => {
    addWorkspace("ws-1", 1);
    addWorkspace("ws-2", 2);
    m.buildMonthlyReport.mockRejectedValueOnce(new Error("db hiccup"));

    const result = await run();

    expect(m.workspaces.find((w) => w.id === "ws-1")?.monthlyReportSentFor).toBeNull();
    expect(m.workspaces.find((w) => w.id === "ws-2")?.monthlyReportSentFor).toBe("2026-10");
    expect(result).toMatchObject({ handled: 1, errors: 1 });
  });

  it("returns counts only: no ids, names or addresses", async () => {
    addWorkspace("ws-1", 1);
    addOwners("ws-1", 1);

    const result = await run();

    expect(Object.values(result).every((value) => typeof value === "number")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ws-1|example\.com|user-/);
  });
});
