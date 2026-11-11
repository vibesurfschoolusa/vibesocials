import { beforeEach, describe, expect, it, vi } from "vitest";

type Ws = {
  id: string;
  name: string;
  billingExempt: boolean;
  plan: string | null;
  trialEndsAt: Date | null;
  trialReminderSentAt: Date | null;
  trialEndedEmailSentAt: Date | null;
  owners: Array<{ userId: string; email: string }>;
};

const m = vi.hoisted(() => ({
  rows: [] as Ws[],
  sendEmail: vi.fn(),
  findManyArgs: [] as unknown[],
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/server/notifications/email", async () => {
  class EmailRetryableError extends Error {}
  return {
    EmailRetryableError,
    sendEmail: m.sendEmail,
    isRetryableEmailError: (error: unknown) => error instanceof EmailRetryableError,
  };
});

/** Applies the where clauses the job uses to the in-memory rows. */
vi.mock("@/lib/db", () => {
  type Where = {
    billingExempt: boolean;
    plan: null;
    trialEndsAt: { gt?: Date; lte: Date };
    trialReminderSentAt?: null;
    trialEndedEmailSentAt?: null;
  };
  const matches = (w: Ws, where: Where) =>
    w.billingExempt === where.billingExempt &&
    w.plan === null &&
    w.trialEndsAt !== null &&
    (where.trialEndsAt.gt === undefined || w.trialEndsAt > where.trialEndsAt.gt) &&
    w.trialEndsAt <= where.trialEndsAt.lte &&
    (!("trialReminderSentAt" in where) || w.trialReminderSentAt === null) &&
    (!("trialEndedEmailSentAt" in where) || w.trialEndedEmailSentAt === null);
  return {
    prisma: {
      workspace: {
        findMany: async (args: { where: Where; take: number }) => {
          m.findManyArgs.push(args);
          return m.rows
            .filter((w) => matches(w, args.where))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, args.take)
            .map((w) => ({
              id: w.id,
              name: w.name,
              trialEndsAt: w.trialEndsAt,
              members: w.owners.map((o) => ({ userId: o.userId, user: { email: o.email } })),
            }));
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Ws> }) => {
          const row = m.rows.find((w) => w.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      },
    },
  };
});

import { EmailRetryableError } from "@/server/notifications/email";

import { REMINDER_MAX_EMAILS_PER_RUN, REMINDER_SEND_INTERVAL_MS, runBillingReminders } from "./reminders";

const NOW = new Date("2026-11-10T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function ws(id: string, overrides: Partial<Ws> = {}): Ws {
  return {
    id,
    name: `Workspace ${id}`,
    billingExempt: false,
    plan: null,
    trialEndsAt: new Date(NOW.getTime() + 2 * DAY),
    trialReminderSentAt: null,
    trialEndedEmailSentAt: null,
    owners: [{ userId: `owner-${id}`, email: `${id}@example.com` }],
    ...overrides,
  };
}

const sleep = vi.fn(async () => {});
const run = () => runBillingReminders(NOW, { sleep });

beforeEach(() => {
  m.rows = [];
  m.findManyArgs = [];
  m.sendEmail.mockReset();
  m.sendEmail.mockResolvedValue(undefined);
  sleep.mockClear();
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("runBillingReminders", () => {
  it("a trial ending within 3 days gets one reminder, and its marker", async () => {
    m.rows = [ws("a")];
    expect(await run()).toEqual({ trialEnding: 1, trialEnded: 0, sent: 1, failed: 0, left: 0 });
    expect(m.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@example.com" }),
      { idempotencyKey: "billing/trial-ending/a/owner-a", throwOnRetryable: true },
    );
    expect(m.sendEmail.mock.calls[0][0].html).toContain("Your free trial ends on 12 November 2026.");
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);

    m.sendEmail.mockClear();
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, left: 0 });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("a trial ending in more than 3 days gets nothing yet", async () => {
    m.rows = [ws("a", { trialEndsAt: new Date(NOW.getTime() + 3 * DAY + 60_000) })];
    expect((await run()).sent).toBe(0);
  });

  it("an ended trial gets one trial-ended email, and its marker", async () => {
    m.rows = [ws("a", { trialEndsAt: new Date(NOW.getTime() - DAY), trialReminderSentAt: new Date(NOW.getTime() - 3 * DAY) })];
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 1, sent: 1, failed: 0, left: 0 });
    expect(m.sendEmail.mock.calls[0][1]).toEqual({ idempotencyKey: "billing/trial-ended/a/owner-a", throwOnRetryable: true });
    expect(m.sendEmail.mock.calls[0][0].html).toContain("Your scheduled posts are on hold until you choose a plan.");
    expect(m.rows[0].trialEndedEmailSentAt).toEqual(NOW);
    m.sendEmail.mockClear();
    await run();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("a workspace that chose a plan, or is exempt, gets neither", async () => {
    m.rows = [
      ws("a", { plan: "starter" }),
      ws("b", { plan: "starter", trialEndsAt: new Date(NOW.getTime() - DAY) }),
      ws("c", { billingExempt: true }),
      ws("d", { trialEndsAt: null }),
    ];
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, left: 0 });
    for (const args of m.findManyArgs as Array<{ where: { plan: null; billingExempt: boolean } }>) {
      expect(args.where.plan).toBeNull();
      expect(args.where.billingExempt).toBe(false);
    }
  });

  it("emails every owner, one send interval apart", async () => {
    m.rows = [
      ws("a", { owners: [{ userId: "u1", email: "one@example.com" }, { userId: "u2", email: "two@example.com" }] }),
      ws("b"),
    ];
    expect((await run()).sent).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(REMINDER_SEND_INTERVAL_MS);
  });

  it("retries a retryable failure once; a second failure leaves the marker unset for tomorrow", async () => {
    m.rows = [ws("a"), ws("b")];
    m.sendEmail
      .mockRejectedValueOnce(new EmailRetryableError("503"))
      .mockRejectedValueOnce(new EmailRetryableError("503"));
    expect(await run()).toEqual({ trialEnding: 2, trialEnded: 0, sent: 1, failed: 1, left: 0 });
    expect(m.sendEmail).toHaveBeenCalledTimes(3);
    expect(m.rows[0].trialReminderSentAt).toBeNull();
    expect(m.rows[1].trialReminderSentAt).toEqual(NOW);
  });

  it("a retry that succeeds counts as sent", async () => {
    m.rows = [ws("a")];
    m.sendEmail.mockRejectedValueOnce(new EmailRetryableError("503"));
    expect((await run()).sent).toBe(1);
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
  });

  it("sends at most the cap per run and reports the rest as left", async () => {
    m.rows = Array.from({ length: REMINDER_MAX_EMAILS_PER_RUN + 5 }, (_, i) => ws(`w${String(i).padStart(3, "0")}`));
    const result = await run();
    expect(result.sent).toBe(REMINDER_MAX_EMAILS_PER_RUN);
    expect(result.left).toBeGreaterThan(0);
    expect(m.sendEmail).toHaveBeenCalledTimes(REMINDER_MAX_EMAILS_PER_RUN);
    for (const args of m.findManyArgs as Array<{ take: number }>) expect(args.take).toBeLessThanOrEqual(REMINDER_MAX_EMAILS_PER_RUN + 1);
  });

  it("returns counts only: no address, name or id", async () => {
    m.rows = [ws("a")];
    const text = JSON.stringify(await run());
    expect(text).not.toContain("@");
    expect(text).not.toContain("Workspace a");
  });

  it("a workspace with no owner is marked without sending", async () => {
    m.rows = [ws("a", { owners: [] })];
    expect((await run()).sent).toBe(0);
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
  });
});
