import { beforeEach, describe, expect, it, vi } from "vitest";

type Ws = {
  id: string;
  name: string;
  billingExempt: boolean;
  plan: string | null;
  trialEndsAt: Date | null;
  trialReminderSentAt: Date | null;
  trialEndedEmailSentAt: Date | null;
  /** How many connected platforms and posts (any status) the workspace has. */
  connections: number;
  posts: number;
  owners: Array<{ userId: string; email: string; timeZone?: string | null }>;
};

const m = vi.hoisted(() => ({
  rows: [] as Ws[],
  sendEmail: vi.fn(),
  findManyArgs: [] as unknown[],
  /** The once-per-owner claims (consumeFixedWindow), by key. */
  claims: new Map<string, { count: number; expiresAt: Date }>(),
  claimsDown: false,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/rateLimit", () => ({
  consumeFixedWindow: async ({ key, limit, resetAt }: { key: string; limit: number; resetAt: Date }) => {
    if (m.claimsDown) return { allowed: false, retryAfterSeconds: 60, unavailable: true };
    const entry = m.claims.get(key) ?? { count: 0, expiresAt: resetAt };
    entry.count += 1;
    m.claims.set(key, entry);
    return entry.count > limit ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
  },
}));
vi.mock("@/server/notifications/email", async () => {
  class EmailRetryableError extends Error {}
  // m.sendEmail answers true (sent), false (a quota 429: try later) or an outcome object.
  const outcome = async (...args: unknown[]) => {
    const answer = await m.sendEmail(...args);
    if (answer === true) return { sent: true };
    if (answer === false || answer === undefined) return { sent: false, reason: "try_later" };
    return answer;
  };
  return {
    EmailRetryableError,
    sendEmailOutcome: outcome,
    sendEmail: async (...args: unknown[]) => (await outcome(...args)).sent,
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
    OR?: Array<{ connections?: { some: object }; postJobs?: { some: object } }>;
  };
  // A relation filter: "has at least one connection or post". Any other shape fails the test.
  const used = (w: Ws, or: Where["OR"]) => {
    if (or === undefined) return true;
    return or.some((clause) => {
      if (clause.connections && Object.keys(clause.connections.some).length === 0) return w.connections > 0;
      if (clause.postJobs && Object.keys(clause.postJobs.some).length === 0) return w.posts > 0;
      throw new Error(`unexpected OR clause ${JSON.stringify(clause)}`);
    });
  };
  const matches = (w: Ws, where: Where) =>
    w.billingExempt === where.billingExempt &&
    w.plan === null &&
    w.trialEndsAt !== null &&
    (where.trialEndsAt.gt === undefined || w.trialEndsAt > where.trialEndsAt.gt) &&
    w.trialEndsAt <= where.trialEndsAt.lte &&
    (!("trialReminderSentAt" in where) || w.trialReminderSentAt === null) &&
    (!("trialEndedEmailSentAt" in where) || w.trialEndedEmailSentAt === null) &&
    used(w, where.OR);
  return {
    prisma: {
      rateLimitEntry: {
        deleteMany: async ({ where }: { where: { key: string } }) => ({ count: Number(m.claims.delete(where.key)) }),
      },
      workspace: {
        findMany: async (args: {
          where: Where;
          take: number;
          select?: { members?: { select?: { user?: { select?: { timeZone?: boolean } } } } };
        }) => {
          m.findManyArgs.push(args);
          // A column comes back only when the query selects it.
          const withZone = args.select?.members?.select?.user?.select?.timeZone === true;
          return m.rows
            .filter((w) => matches(w, args.where))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, args.take)
            .map((w) => ({
              id: w.id,
              name: w.name,
              trialEndsAt: w.trialEndsAt,
              members: w.owners.map((o) => ({
                userId: o.userId,
                user: { email: o.email, ...(withZone ? { timeZone: o.timeZone ?? null } : {}) },
              })),
            }));
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Ws> }) => {
          const row = m.rows.find((w) => w.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
        updateMany: async ({ where, data }: { where: { id: string; trialEndsAt: Date }; data: Partial<Ws> }) => {
          const rows = m.rows.filter((w) => w.id === where.id && w.trialEndsAt?.getTime() === where.trialEndsAt.getTime());
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
    },
  };
});

import { EmailRetryableError } from "@/server/notifications/email";

import {
  REMINDER_MAX_EMAILS_PER_RUN,
  REMINDER_SEND_INTERVAL_MS,
  runBillingReminders,
  TRIAL_ENDED_CLAIM_MS,
  TRIAL_ENDED_NOTICE_WINDOW_MS,
  trialEmailClaimsWhere,
} from "./reminders";

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
    connections: 1,
    posts: 1,
    owners: [{ userId: `owner-${id}`, email: `${id}@example.com` }],
    ...overrides,
  };
}

const sleep = vi.fn(async () => {});
const run = () => runBillingReminders(NOW, { sleep });

beforeEach(() => {
  m.rows = [];
  m.findManyArgs = [];
  m.claims.clear();
  m.claimsDown = false;
  m.sendEmail.mockReset();
  m.sendEmail.mockResolvedValue(true);
  sleep.mockClear();
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("runBillingReminders", () => {
  // F4: the Plan link opens this workspace through /go, in both reminders.
  it.each([
    ["trial ending", {}],
    ["trial ended", { trialEndsAt: new Date(NOW.getTime() - DAY), trialReminderSentAt: new Date(NOW.getTime() - 3 * DAY) }],
  ])("the %s email links to this workspace's Settings, Plan", async (_name, over) => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
    try {
      m.rows = [ws("a", over)];
      await run();
      expect(m.sendEmail.mock.calls[0][0].html).toContain(
        'href="https://app.example.test/go?w=a&amp;to=%2Fsettings%23plan"',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a trial ending within 3 days gets one reminder, and its marker", async () => {
    m.rows = [ws("a")];
    expect(await run()).toEqual({ trialEnding: 1, trialEnded: 0, sent: 1, failed: 0, refused: 0, left: 0 });
    expect(m.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@example.com" }),
      { idempotencyKey: "billing/trial-ending/a/owner-a/2026-11-12T16:00:00.000Z", throwOnRetryable: true },
    );
    expect(m.sendEmail.mock.calls[0][0].html).toMatch(/Your free trial ends on \w{3}, Nov 12, 2026, [^<]* UTC\./);
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);

    m.sendEmail.mockClear();
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, refused: 0, left: 0 });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  // R3-pages L1: each owner reads the end time in their own time zone.
  it("builds the trial-ending email per owner, in that owner's time zone", async () => {
    m.rows = [
      ws("a", {
        owners: [
          { userId: "owner-ny", email: "ny@example.com", timeZone: "America/New_York" },
          { userId: "owner-jhb", email: "jhb@example.com", timeZone: "Africa/Johannesburg" },
          { userId: "owner-none", email: "none@example.com", timeZone: null },
        ],
      }),
    ];
    await run();
    const html = (to: string) => m.sendEmail.mock.calls.find((call) => call[0].to === to)![0].html as string;
    // Ends 2026-11-12 16:00 UTC: 11:00 in New York, 18:00 in Johannesburg.
    expect(html("ny@example.com")).toMatch(/Nov 12, 2026, 11:00\s?AM/);
    expect(html("ny@example.com")).not.toContain("UTC");
    expect(html("jhb@example.com")).toMatch(/Nov 12, 2026, 6:00\s?PM/);
    expect(html("none@example.com")).toMatch(/Nov 12, 2026, 4:00\s?PM UTC/);
  });

  it("a trial ending in more than 3 days gets nothing yet", async () => {
    m.rows = [ws("a", { trialEndsAt: new Date(NOW.getTime() + 3 * DAY + 60_000) })];
    expect((await run()).sent).toBe(0);
  });

  it("an ended trial gets one trial-ended email, and its marker", async () => {
    m.rows = [ws("a", { trialEndsAt: new Date(NOW.getTime() - DAY), trialReminderSentAt: new Date(NOW.getTime() - 3 * DAY) })];
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 1, sent: 1, failed: 0, refused: 0, left: 0 });
    expect(m.sendEmail.mock.calls[0][1]).toEqual({
      idempotencyKey: "billing/trial-ended/a/owner-a/2026-11-09T16:00:00.000Z",
      throwOnRetryable: true,
    });
    expect(m.sendEmail.mock.calls[0][0].html).toContain(
      "Your free trial has ended, so posting has stopped. A scheduled post that comes due without a plan is marked failed. Once you choose a plan you can retry it from Activity, as long as its photos and videos are still kept: those of finished posts are removed 30 days after they were last added to a post.",
    );
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
    expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, refused: 0, left: 0 });
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
    expect(await run()).toEqual({ trialEnding: 2, trialEnded: 0, sent: 1, failed: 1, refused: 0, left: 0 });
    expect(m.sendEmail).toHaveBeenCalledTimes(3);
    expect(m.rows[0].trialReminderSentAt).toBeNull();
    expect(m.rows[1].trialReminderSentAt).toEqual(NOW);
  });

  // R40 security L3: a co-owner's failure never sends the others a second copy the next day.
  it("owner A reached and owner B failed: the next day only B is sent, then the marker is set", async () => {
    const owners = [
      { userId: "u1", email: "one@example.com" },
      { userId: "u2", email: "two@example.com" },
    ];
    m.rows = [ws("a", { owners })];
    m.sendEmail
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new EmailRetryableError("503"))
      .mockRejectedValueOnce(new EmailRetryableError("503"));
    expect(await run()).toEqual({ trialEnding: 1, trialEnded: 0, sent: 1, failed: 1, refused: 0, left: 0 });
    expect(m.rows[0].trialReminderSentAt).toBeNull();

    m.sendEmail.mockClear();
    const tomorrow = new Date(NOW.getTime() + DAY);
    expect(await runBillingReminders(tomorrow, { sleep })).toEqual({ trialEnding: 1, trialEnded: 0, sent: 1, failed: 0, refused: 0, left: 0 });
    expect(m.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(["two@example.com"]);
    expect(m.rows[0].trialReminderSentAt).toEqual(tomorrow);
  });

  it("each owner's claim lasts until the trial date; an ended trial's, TRIAL_ENDED_CLAIM_MS from its first try", async () => {
    m.rows = [ws("a"), ws("b", { trialEndsAt: new Date(NOW.getTime() - DAY) })];
    await run();
    expect([...m.claims.values()].map((claim) => claim.expiresAt)).toEqual([
      m.rows[0].trialEndsAt,
      new Date(NOW.getTime() + TRIAL_ENDED_CLAIM_MS),
    ]);
  });

  it("a claim store that can't answer sends nothing and leaves the marker unset for tomorrow", async () => {
    m.rows = [ws("a")];
    m.claimsDown = true;
    expect(await run()).toEqual({ trialEnding: 1, trialEnded: 0, sent: 0, failed: 1, refused: 0, left: 0 });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.rows[0].trialReminderSentAt).toBeNull();

    m.claimsDown = false;
    expect((await runBillingReminders(new Date(NOW.getTime() + DAY), { sleep })).sent).toBe(1);
  });

  it("a retry that succeeds counts as sent", async () => {
    m.rows = [ws("a")];
    m.sendEmail.mockRejectedValueOnce(new EmailRetryableError("503"));
    expect((await run()).sent).toBe(1);
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
  });

  // R41 security L1: sendEmail answers false, without throwing, when Resend did
  // not take the email (a quota 429, another 4xx, no key, a bad key).
  it.each([
    ["trial ending", {}, "trialReminderSentAt"],
    ["trial ended", { trialEndsAt: new Date(NOW.getTime() - DAY) }, "trialEndedEmailSentAt"],
  ] as const)("a %s email Resend didn't take is not marked, and the next run sends it", async (_name, over, marker) => {
    m.rows = [ws("a", over)];
    m.sendEmail.mockResolvedValueOnce(false);
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect(m.rows[0][marker]).toBeNull();
    expect(m.claims.size).toBe(0);

    m.sendEmail.mockClear();
    const tomorrow = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await runBillingReminders(tomorrow, { sleep })).toMatchObject({ sent: 1, failed: 0 });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.rows[0][marker]).toEqual(tomorrow);
  });

  it("a retry Resend didn't take counts as failed", async () => {
    m.rows = [ws("a")];
    m.sendEmail.mockRejectedValueOnce(new EmailRetryableError("503")).mockResolvedValueOnce(false);
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect(m.rows[0].trialReminderSentAt).toBeNull();
  });

  // R41 security L2: the operator's new trial date clears both markers
  // (admin/actions.ts), so the new date gets its own emails.
  it("a trial extended after it ended gets a new reminder, then a new ended email", async () => {
    m.rows = [ws("a", { trialEndsAt: new Date(NOW.getTime() - DAY) })];
    await run();
    expect(m.rows[0].trialEndedEmailSentAt).toEqual(NOW);

    const newEnd = new Date(NOW.getTime() + 14 * DAY);
    Object.assign(m.rows[0], { trialEndsAt: newEnd, trialReminderSentAt: null, trialEndedEmailSentAt: null });
    m.sendEmail.mockClear();
    const beforeEnd = new Date(newEnd.getTime() - 2 * DAY);
    expect(await runBillingReminders(beforeEnd, { sleep })).toMatchObject({ trialEnding: 1, sent: 1 });
    expect(m.sendEmail.mock.calls[0][1].idempotencyKey).toBe(`billing/trial-ending/a/owner-a/${newEnd.toISOString()}`);

    m.sendEmail.mockClear();
    const afterEnd = new Date(newEnd.getTime() + DAY);
    expect(await runBillingReminders(afterEnd, { sleep })).toMatchObject({ trialEnded: 1, sent: 1 });
    expect(m.sendEmail.mock.calls[0][1].idempotencyKey).toBe(`billing/trial-ended/a/owner-a/${newEnd.toISOString()}`);
  });

  it("a date changed within 24 h of a reminder sends under a new key", async () => {
    m.rows = [ws("a")];
    await run();
    const firstKey = m.sendEmail.mock.calls[0][1].idempotencyKey;

    Object.assign(m.rows[0], { trialEndsAt: new Date(NOW.getTime() + DAY), trialReminderSentAt: null });
    m.sendEmail.mockClear();
    expect((await runBillingReminders(new Date(NOW.getTime() + 60 * 60 * 1000), { sleep })).sent).toBe(1);
    expect(m.sendEmail.mock.calls[0][1].idempotencyKey).not.toBe(firstKey);
  });

  // R41 lead review: what the operator's change does (admin/actions.ts), applied to the store.
  const operatorSets = (row: Ws, trialEndsAt: Date) => {
    const where = trialEmailClaimsWhere(row.id);
    for (const key of [...m.claims.keys()]) {
      if (where.OR.some((clause) => key.startsWith(clause.key.startsWith))) m.claims.delete(key);
    }
    Object.assign(row, { trialEndsAt, trialReminderSentAt: null, trialEndedEmailSentAt: null });
  };

  it("a date put back (A, then B, then A) sends A's reminder again", async () => {
    const a = new Date(NOW.getTime() + 2 * DAY);
    const b = new Date(NOW.getTime() + 2.5 * DAY);
    m.rows = [ws("x", { trialEndsAt: a })];
    expect((await run()).sent).toBe(1);

    operatorSets(m.rows[0], b);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect((await runBillingReminders(later, { sleep })).sent).toBe(1);

    operatorSets(m.rows[0], a);
    m.sendEmail.mockClear();
    const laterStill = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    expect((await runBillingReminders(laterStill, { sleep })).sent).toBe(1);
    expect(m.sendEmail.mock.calls[0][1].idempotencyKey).toBe(`billing/trial-ending/x/owner-x/${a.toISOString()}`);
    expect(m.rows[0].trialReminderSentAt).toEqual(laterStill);
  });

  // R41 lead review: the marker is written for the date the run read.
  it.each([
    ["reminder", 2 * DAY, 2.5 * DAY, "trialReminderSentAt", "trial-ending"],
    ["ended email", -DAY, -DAY / 2, "trialEndedEmailSentAt", "trial-ended"],
  ] as const)(
    "a date changed while the %s is sent leaves the marker clear, and the next run sends the new date's",
    async (_name, aOffset, bOffset, marker, kind) => {
      const a = new Date(NOW.getTime() + aOffset);
      const b = new Date(NOW.getTime() + bOffset);
      m.rows = [ws("x", { trialEndsAt: a })];
      m.sendEmail.mockImplementationOnce(async () => {
        operatorSets(m.rows[0], b);
        return true;
      });
      expect((await run()).sent).toBe(1);
      expect(m.rows[0][marker]).toBeNull();

      m.sendEmail.mockClear();
      const later = new Date(NOW.getTime() + 60 * 60 * 1000);
      expect((await runBillingReminders(later, { sleep })).sent).toBe(1);
      expect(m.sendEmail.mock.calls[0][1].idempotencyKey).toBe(`billing/${kind}/x/owner-x/${b.toISOString()}`);
      expect(m.rows[0][marker]).toEqual(later);
    },
  );

  it("an unchanged date gets its marker, written for the date read", async () => {
    m.rows = [ws("x")];
    await run();
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
  });

  it("the claims released are this workspace's trial emails only", () => {
    expect(trialEmailClaimsWhere("ws-1")).toEqual({
      OR: [
        { key: { startsWith: "billing-owner:trial-ending:ws-1:" } },
        { key: { startsWith: "billing-owner:trial-ended:ws-1:" } },
      ],
    });
  });

  // R41 lead review: refused for good means done, not tried every day.
  it("an owner whose email Resend refused for good (422) is not tried again; the workspace is done", async () => {
    const owners = [
      { userId: "u1", email: "one@example.com" },
      { userId: "u2", email: "two@example.com" },
    ];
    m.rows = [ws("a", { owners })];
    m.sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce({ sent: false, reason: "refused" });
    expect(await run()).toEqual({ trialEnding: 1, trialEnded: 0, sent: 1, failed: 0, refused: 1, left: 0 });
    expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
    expect(m.logger.warn).toHaveBeenCalledWith(expect.stringContaining("not tried again"), {
      kind: "trial-ending",
      workspaceId: "a",
      userId: "u2",
    });

    // Even were the marker cleared, the refused owner's claim holds.
    m.rows[0].trialReminderSentAt = null;
    m.sendEmail.mockClear();
    expect((await runBillingReminders(new Date(NOW.getTime() + DAY / 2), { sleep })).sent).toBe(0);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["a quota 429", { sent: false, reason: "try_later" }],
    ["no key or a bad key", { sent: false, reason: "not_configured" }],
  ])("an owner not sent for %s is tried again at the next run", async (_name, answer) => {
    m.rows = [ws("a")];
    m.sendEmail.mockResolvedValueOnce(answer);
    expect(await run()).toMatchObject({ sent: 0, failed: 1, refused: 0 });
    expect(m.rows[0].trialReminderSentAt).toBeNull();
    m.sendEmail.mockClear();
    expect((await runBillingReminders(new Date(NOW.getTime() + DAY / 2), { sleep })).sent).toBe(1);
  });

  it("a trial that ended more than 30 days ago gets no notice", async () => {
    m.rows = [
      ws("old", { trialEndsAt: new Date(NOW.getTime() - TRIAL_ENDED_NOTICE_WINDOW_MS - 1) }),
      ws("recent", { trialEndsAt: new Date(NOW.getTime() - TRIAL_ENDED_NOTICE_WINDOW_MS + 60_000) }),
    ];
    expect(await run()).toMatchObject({ trialEnded: 1, sent: 1 });
    expect(m.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(["recent@example.com"]);
    expect(TRIAL_ENDED_NOTICE_WINDOW_MS).toBe(30 * DAY);
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

  describe("only a workspace someone uses", () => {
    const unused = { connections: 0, posts: 0 };
    const ended = { trialEndsAt: new Date(NOW.getTime() - DAY) };

    it("a used workspace in its last days gets the reminder, as before", async () => {
      m.rows = [ws("a")];
      expect((await run()).sent).toBe(1);
      expect(m.rows[0].trialReminderSentAt).toEqual(NOW);
    });

    it("an unused workspace in its last days gets no reminder, and its marker stays null", async () => {
      m.rows = [ws("a", unused)];
      expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, refused: 0, left: 0 });
      expect(m.sendEmail).not.toHaveBeenCalled();
      expect(m.rows[0].trialReminderSentAt).toBeNull();
    });

    it("a post alone makes a workspace used", async () => {
      m.rows = [ws("a", { connections: 0, posts: 1 })];
      expect((await run()).sent).toBe(1);
    });

    it("a connection alone makes a workspace used", async () => {
      m.rows = [ws("a", { connections: 1, posts: 0 })];
      expect((await run()).sent).toBe(1);
    });

    it("an unused workspace whose trial ended gets no notice, and its marker stays null", async () => {
      m.rows = [ws("a", { ...unused, ...ended })];
      expect(await run()).toEqual({ trialEnding: 0, trialEnded: 0, sent: 0, failed: 0, refused: 0, left: 0 });
      expect(m.rows[0].trialEndedEmailSentAt).toBeNull();
    });

    it("a workspace first used after the reminder window still gets the ended notice, once", async () => {
      m.rows = [ws("a", unused)];
      await run();
      expect(m.sendEmail).not.toHaveBeenCalled();

      Object.assign(m.rows[0], { posts: 1, ...ended });
      expect(await run()).toEqual({ trialEnding: 0, trialEnded: 1, sent: 1, failed: 0, refused: 0, left: 0 });
      expect(m.sendEmail.mock.calls[0][1].idempotencyKey).toBe("billing/trial-ended/a/owner-a/2026-11-09T16:00:00.000Z");
      expect(m.rows[0].trialReminderSentAt).toBeNull();
      expect(m.rows[0].trialEndedEmailSentAt).toEqual(NOW);

      m.sendEmail.mockClear();
      await run();
      expect(m.sendEmail).not.toHaveBeenCalled();
    });

    it("filters in the query's where, so unused workspaces are never loaded", async () => {
      await run();
      expect(m.findManyArgs).toHaveLength(2);
      for (const args of m.findManyArgs as Array<{ where: Record<string, unknown> }>) {
        expect(args.where.OR).toEqual([{ connections: { some: {} } }, { postJobs: { some: {} } }]);
      }
    });
  });
});
