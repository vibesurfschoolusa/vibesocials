import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: the monthly report email goes only to workspaces whose plan includes
 * it. A Starter workspace is skipped (no report built, no email) and marked
 * for the month like one with nothing to report, so the next two runs do not
 * look at it again. Growth, a trial and an exempt workspace get it as before.
 */

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  findMany: vi.fn(),
  buildMonthlyReport: vi.fn(),
  sendEmail: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findMany: (args: unknown) => {
        m.findMany(args);
        return m.rows;
      },
      count: async () => 0,
      updateMany: m.updateMany,
    },
    workspaceMember: {
      findMany: async ({ where }: { where: { workspaceId: string } }) => [
        { userId: `owner-${where.workspaceId}`, user: { email: `owner@${where.workspaceId}.example.com` } },
      ],
    },
    workspaceReviewLink: { findFirst: async () => null },
  },
}));
vi.mock("@/server/reports/monthlyReport", () => ({ buildMonthlyReport: m.buildMonthlyReport }));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: m.sendEmail,
}));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runMonthlyReportEmails } from "./monthlyReportEmail";

const NOW = new Date("2026-12-01T15:00:00Z");
const LATER = new Date("2026-12-20T00:00:00Z");
const CREATED = new Date("2026-01-01T00:00:00Z");

const row = (id: string, billing: Record<string, unknown>) => ({ id, createdAt: CREATED, ...billing });
const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };

function report(workspaceId: string) {
  return {
    workspaceName: workspaceId,
    month: "2026-11",
    logoUrl: null,
    inProgress: false,
    postCount: 2,
    posts: [],
    totals: { resultsByPlatform: [], numbers: [] },
    listing: null,
    failed: [],
  };
}

beforeEach(() => {
  for (const fn of [m.findMany, m.buildMonthlyReport, m.sendEmail, m.updateMany]) fn.mockReset();
  m.buildMonthlyReport.mockImplementation(async (workspaceId: string) => report(workspaceId));
  m.sendEmail.mockResolvedValue(undefined);
  m.updateMany.mockResolvedValue({ count: 1 });
  m.rows = [
    row("ws-starter", STARTER),
    row("ws-growth", { ...STARTER, plan: "growth" }),
    row("ws-trial", { trialEndsAt: LATER }),
    row("ws-exempt", { billingExempt: true, ...STARTER }),
  ];
});
afterEach(() => vi.unstubAllEnvs());

const sentTo = () => m.sendEmail.mock.calls.map((call) => (call[0] as { to: string }).to);

describe("the monthly report email by plan", () => {
  it("with billing on, skips Starter and sends to Growth, a trial and an exempt workspace", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const result = await runMonthlyReportEmails({ now: NOW, sleep: async () => {} });

    expect(m.buildMonthlyReport.mock.calls.map((call) => call[0])).toEqual(["ws-growth", "ws-trial", "ws-exempt"]);
    expect(sentTo()).toEqual([
      "owner@ws-growth.example.com",
      "owner@ws-trial.example.com",
      "owner@ws-exempt.example.com",
    ]);
    // Marked for the month like the others, so the next runs pass it by.
    expect(m.updateMany).toHaveBeenCalledWith({ where: { id: "ws-starter" }, data: { monthlyReportSentFor: "2026-11" } });
    expect(result).toMatchObject({ handled: 4, emailed: 3, notIncluded: 1 });
    // The plan columns come in the same query.
    expect(m.findMany.mock.calls[0][0]).toMatchObject({
      select: { id: true, createdAt: true, billingExempt: true, plan: true, planStatus: true },
    });
  });

  it("with billing off, sends to every workspace and reads only today's columns", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const result = await runMonthlyReportEmails({ now: NOW, sleep: async () => {} });

    expect(sentTo()).toHaveLength(4);
    expect(result).toMatchObject({ handled: 4, emailed: 4, notIncluded: 0 });
    expect(m.findMany.mock.calls[0][0]).toMatchObject({ select: { id: true, createdAt: true } });
    expect(Object.keys((m.findMany.mock.calls[0][0] as { select: object }).select)).toEqual(["id", "createdAt"]);
  });
});
