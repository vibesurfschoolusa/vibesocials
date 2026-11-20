import type { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R5-publishing M1: no connection may die unannounced. The daily sweep's last
// step warns a week before a sign-in that cannot be renewed lapses, flags it
// when it has, and emails the owners of every flagged connection that has not
// had its reconnect email (a failed post flags without one). An in-memory table
// stands in for SocialConnection; no database, Resend or Inngest is reached.
const {
  table,
  findManyMock,
  findUniqueMock,
  updateManyMock,
  workspaceFindUniqueMock,
  membersFindManyMock,
  sendEmailMock,
  claims,
  reached,
  consumeMock,
} = vi.hoisted(() => ({
    claims: new Map<string, Date>(),
    reached: new Set<string>(),
    consumeMock: vi.fn(),
    table: new Map<string, Record<string, unknown>>(),
    findManyMock: vi.fn(),
    findUniqueMock: vi.fn(),
    updateManyMock: vi.fn(),
    workspaceFindUniqueMock: vi.fn(),
    membersFindManyMock: vi.fn(),
    sendEmailMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: membersFindManyMock },
    // sendOncePer lets a claim go through this.
    rateLimitEntry: {
      deleteMany: async ({ where }: { where: { key: string } }) => ({ count: claims.delete(where.key) ? 1 : 0 }),
      // R44: the mark a claim's send leaves once it answered.
      upsert: async ({ where }: { where: { key: string } }) => reached.add(where.key),
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (reached.has(where.key)) return { key: where.key };
        const expiresAt = claims.get(where.key);
        return expiresAt ? { key: where.key, count: 1, expiresAt } : null;
      },
    },
  },
}));
// R43 review: each owner's claim (sendOncePer) is an in-memory set here.
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmailOutcome: sendEmailMock,
}));

import { EmailRetryableError } from "@/server/notifications/email";
import { htmlToPlainText } from "@/server/notifications/plainText";
import { expiryNoticeWhere } from "./connectionHealthSweep";
import {
  CONNECTION_EXPIRED_CODE,
  CONNECTION_FLAG_SCAN_LIMIT,
  CONNECTION_NOTICES_BATCH,
  notifyOwnersToReconnect,
  sendConnectionNotices,
} from "./connectionNotices";

const NOW = new Date("2026-11-14T04:45:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = "2026-11-14";

function row(id: string, fields: Record<string, unknown> = {}) {
  table.set(id, {
    id,
    platform: "linkedin" as Platform,
    workspaceId: "ws-1",
    refreshToken: null,
    expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    reconnectEmailedAt: null,
    expiryWarnedFor: null,
    ...fields,
  });
}

const time = (value: unknown) => (value === null || value === undefined ? null : new Date(value as Date).getTime());

/** Does `r` match the subset of a Prisma WHERE the module uses? */
function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Record<string, unknown>[]).some((branch) => matches(r, branch))) return false;
      continue;
    }
    const value = r[key];
    if (condition === null || typeof condition !== "object" || condition instanceof Date) {
      if (condition instanceof Date ? time(value) !== condition.getTime() : value !== condition) return false;
      continue;
    }
    const c = condition as { not?: unknown; lt?: unknown; lte?: unknown; notIn?: unknown[] };
    if ("not" in c && c.not === null && value === null) return false;
    if (c.notIn && c.notIn.includes(value)) return false;
    if (c.lte !== undefined && !(value !== null && time(value)! <= time(c.lte)!)) return false;
    if (c.lt !== undefined && !(value !== null && time(value)! < time(c.lt)!)) return false;
  }
  return true;
}

function pick(r: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((key) => [key, r[key]]));
}

const OWNERS = [
  { user: { id: "user-a", email: "owner-a@example.com", timeZone: "America/New_York" } },
  { user: { id: "user-b", email: "owner-b@example.com", timeZone: null } },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  table.clear();
  claims.clear();
  reached.clear();
  consumeMock.mockReset();
  consumeMock.mockImplementation(async ({ key, resetAt }: { key: string; resetAt: Date }) => {
    if (claims.has(key)) return { allowed: false, retryAfterSeconds: 60 };
    claims.set(key, resetAt);
    return { allowed: true };
  });
  for (const mock of [findManyMock, findUniqueMock, updateManyMock, workspaceFindUniqueMock, membersFindManyMock, sendEmailMock]) {
    mock.mockReset();
  }
  findManyMock.mockImplementation(
    async (args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
      orderBy?: Record<string, "asc" | "desc">;
      take: number;
    }) => {
      const rows = [...table.values()].filter((r) => matches(r, args.where));
      // One-key orderBy on a date or id column, as the module sends it.
      const [key, direction] = Object.entries(args.orderBy ?? {})[0] ?? [];
      if (key) {
        const sign = direction === "desc" ? -1 : 1;
        rows.sort((a, b) => sign * (key === "id" ? String(a.id).localeCompare(String(b.id)) : time(a[key])! - time(b[key])!));
      }
      return rows.slice(0, args.take).map((r) => pick(r, args.select));
    },
  );
  findUniqueMock.mockImplementation(async (args: { where: { id: string }; select: Record<string, boolean> }) => {
    const r = table.get(args.where.id);
    return r ? pick(r, args.select) : null;
  });
  updateManyMock.mockImplementation(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of table.values()) {
      if (matches(r, args.where)) {
        Object.assign(r, args.data);
        count++;
      }
    }
    return { count };
  });
  workspaceFindUniqueMock.mockResolvedValue({ name: "Acme" });
  membersFindManyMock.mockResolvedValue(OWNERS);
  sendEmailMock.mockResolvedValue({ sent: true });
  vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("notifyOwnersToReconnect", () => {
  it("emails each owner once with the per-day key, then records the email on the connection", async () => {
    row("conn-1", { needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - DAY_MS) });

    expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 2 });

    expect(sendEmailMock.mock.calls.map((call) => [call[0].to, call[1]])).toEqual([
      ["owner-a@example.com", { idempotencyKey: "reconnect/conn-1/2026-11-14/user-a", throwOnRetryable: true }],
      ["owner-b@example.com", { idempotencyKey: "reconnect/conn-1/2026-11-14/user-b", throwOnRetryable: true }],
    ]);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe("Action needed: reconnect LinkedIn in Acme");
    expect(sendEmailMock.mock.calls[0][0].html).toContain("If your client connected it");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "conn-1", needsReconnect: true },
      data: { reconnectEmailedAt: NOW },
    });
    expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
  });

  it("sends nothing for a connection that is not flagged (reconnected meanwhile) or gone", async () => {
    row("conn-1");
    expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 0 });
    expect(await notifyOwnersToReconnect("missing", DAY)).toEqual({ emailed: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends nothing when this flag already had its email", async () => {
    row("conn-1", {
      needsReconnect: true,
      refreshFailedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      reconnectEmailedAt: new Date(NOW.getTime() - DAY_MS),
    });

    expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("emails again for a new flag after an earlier email (reconnected, then failed again)", async () => {
    row("conn-1", {
      needsReconnect: true,
      refreshFailedAt: new Date(NOW.getTime() - DAY_MS),
      reconnectEmailedAt: new Date(NOW.getTime() - 40 * DAY_MS),
    });

    expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 2 });
  });

  it("a flag with no recorded time and no email yet is emailed", async () => {
    row("conn-1", { needsReconnect: true });

    expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 2 });
  });

  it("a lapsed sign-in says it expired and cannot be renewed", async () => {
    row("conn-1", { needsReconnect: true, lastRefreshErrorCode: CONNECTION_EXPIRED_CODE, refreshFailedAt: NOW });

    await notifyOwnersToReconnect("conn-1", DAY);

    expect(sendEmailMock.mock.calls[0][0].html).toContain(
      "its sign-in expired, and LinkedIn does not let us renew it automatically.",
    );
  });

  it("a retryable send error throws and records nothing, so the retry sends again", async () => {
    row("conn-1", { needsReconnect: true, refreshFailedAt: NOW });
    sendEmailMock.mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 503)"));

    await expect(notifyOwnersToReconnect("conn-1", DAY)).rejects.toBeInstanceOf(EmailRetryableError);
    expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();
  });
});

// R43 platform L1: a notice is recorded as sent only when it went. A quota
// answer or a set-up error resolves without throwing, so the stamp waits and
// the next sweep tries again; an owner Resend refused for good counts as done,
// so one bad address can't hold the stamp back for ever.
describe("a notice that didn't go is not recorded", () => {
  const TRY_LATER = { sent: false, reason: "try_later" } as const;
  const NOT_CONFIGURED = { sent: false, reason: "not_configured" } as const;
  const REFUSED = { sent: false, reason: "refused" } as const;
  const SENT = { sent: true } as const;
  const run = () => sendConnectionNotices(NOW.toISOString(), DAY);

  describe("reconnect email", () => {
    beforeEach(() => row("conn-1", { needsReconnect: true, refreshFailedAt: NOW }));

    for (const [name, outcome] of [
      ["a quota answer", TRY_LATER],
      ["no or a bad key", NOT_CONFIGURED],
    ] as const) {
      it(`${name}: nothing is recorded, and the next sweep sends`, async () => {
        sendEmailMock.mockResolvedValue(outcome);
        expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
        expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();

        sendEmailMock.mockReset();
        sendEmailMock.mockResolvedValue(SENT);
        expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 2 });
        expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
      });
    }

    it("one owner sent, one refused for good: recorded, and only the sent one is counted", async () => {
      sendEmailMock.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(SENT);
      expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 1 });
      expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
    });

    it("every owner refused for good: recorded, none counted", async () => {
      sendEmailMock.mockResolvedValue(REFUSED);
      expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 0 });
      expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
    });

    it("one owner sent, one to try later: not recorded, so that owner is tried at the next sweep", async () => {
      sendEmailMock.mockResolvedValueOnce(SENT).mockResolvedValueOnce(TRY_LATER);
      expect(await notifyOwnersToReconnect("conn-1", DAY)).toEqual({ emailed: 1 });
      expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();
    });
  });

  describe("expiry warning", () => {
    const expiresAt = new Date("2026-11-20T15:30:00.000Z");
    beforeEach(() => row("conn-1", { expiresAt }));

    for (const [name, outcome] of [
      ["a quota answer", TRY_LATER],
      ["no or a bad key", NOT_CONFIGURED],
    ] as const) {
      it(`${name}: nothing is recorded, and the next sweep sends`, async () => {
        sendEmailMock.mockResolvedValue(outcome);
        expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
        expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();

        sendEmailMock.mockReset();
        sendEmailMock.mockResolvedValue(SENT);
        expect(await run()).toEqual({ warned: 1, lapsed: 0, reconnectEmails: 0 });
        expect(sendEmailMock).toHaveBeenCalledTimes(2);
        expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
      });
    }

    it("one owner refused for good, one sent: recorded", async () => {
      sendEmailMock.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(SENT);
      expect(await run()).toEqual({ warned: 1, lapsed: 0, reconnectEmails: 0 });
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    });

    it("every owner refused for good: recorded, so it is not tried again", async () => {
      sendEmailMock.mockResolvedValue(REFUSED);
      expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
      sendEmailMock.mockClear();
      await run();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });
});

// R43 review: an owner already reached is never emailed again for the same
// notice, through a claim per owner (sendOncePer, as the trial emails do).
describe("each owner is told once per notice", () => {
  const TRY_LATER = { sent: false, reason: "try_later" } as const;
  const REFUSED = { sent: false, reason: "refused" } as const;
  const SENT = { sent: true } as const;
  const run = (day = DAY) => sendConnectionNotices(NOW.toISOString(), day);
  const recipients = () => sendEmailMock.mock.calls.map((call) => call[0].to);

  describe("reconnect email", () => {
    const FLAG = new Date(NOW.getTime() - DAY_MS);
    beforeEach(() => row("conn-1", { needsReconnect: true, refreshFailedAt: FLAG }));

    it("claims each owner by the flag's time, for 30 days", async () => {
      await run();
      expect([...claims.keys()]).toEqual([
        `connection-reconnect-owner:conn-1:${FLAG.toISOString()}:user-a`,
        `connection-reconnect-owner:conn-1:${FLAG.toISOString()}:user-b`,
      ]);
      expect(claims.get(`connection-reconnect-owner:conn-1:${FLAG.toISOString()}:user-a`)!.getTime()).toBe(
        NOW.getTime() + 30 * DAY_MS,
      );
    });

    it("A sent, B to try later: the next sweep (the next day) emails only B, then records it", async () => {
      sendEmailMock.mockResolvedValueOnce(SENT).mockResolvedValueOnce(TRY_LATER);
      expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 1 });
      expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();

      sendEmailMock.mockClear();
      expect(await run("2026-11-15")).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 1 });
      expect(recipients()).toEqual(["owner-b@example.com"]);
      expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
    });

    it("an owner refused for good counts as done, and is not tried again", async () => {
      sendEmailMock.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(TRY_LATER);
      await run();
      sendEmailMock.mockClear();
      await run("2026-11-15");
      expect(recipients()).toEqual(["owner-b@example.com"]);
      expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
    });

    it("a new flag time emails both owners again", async () => {
      await run();
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      table.get("conn-1")!.refreshFailedAt = new Date(NOW.getTime() + 60_000);
      vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
      sendEmailMock.mockClear();
      await run();
      expect(recipients()).toEqual(["owner-a@example.com", "owner-b@example.com"]);
    });

    it("a retryable error: the other owner is still tried, then it is thrown and nothing is recorded", async () => {
      sendEmailMock
        .mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 503)"))
        .mockResolvedValueOnce(SENT);
      await expect(run()).rejects.toBeInstanceOf(EmailRetryableError);
      expect(recipients()).toEqual(["owner-a@example.com", "owner-b@example.com"]);
      expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();

      sendEmailMock.mockClear();
      await run();
      expect(recipients()).toEqual(["owner-a@example.com"]);
      expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
    });
  });

  describe("expiry warning", () => {
    const expiresAt = new Date("2026-11-20T15:30:00.000Z");
    beforeEach(() => row("conn-1", { expiresAt }));

    it("claims each owner by the expiry, until it", async () => {
      await run();
      const key = `connection-expiry-owner:conn-1:${expiresAt.toISOString()}:user-a`;
      expect(claims.get(key)!.getTime()).toBe(expiresAt.getTime());
    });

    it("A sent, B to try later: the next sweep emails only B, then records it", async () => {
      sendEmailMock.mockResolvedValueOnce(SENT).mockResolvedValueOnce(TRY_LATER);
      expect(await run()).toEqual({ warned: 1, lapsed: 0, reconnectEmails: 0 });
      expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();

      sendEmailMock.mockClear();
      await run("2026-11-15");
      expect(recipients()).toEqual(["owner-b@example.com"]);
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    });

    it("an owner refused for good counts as done", async () => {
      sendEmailMock.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(SENT);
      await run();
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    });

    it("a new expiry (a reconnect) warns both owners again", async () => {
      await run();
      table.get("conn-1")!.expiresAt = new Date("2026-11-20T20:00:00.000Z");
      sendEmailMock.mockClear();
      await run();
      expect(recipients()).toEqual(["owner-a@example.com", "owner-b@example.com"]);
    });

    it("a retryable error: the other owner is still tried, then it is thrown and nothing is recorded", async () => {
      sendEmailMock
        .mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 503)"))
        .mockResolvedValueOnce(SENT);
      await expect(run()).rejects.toBeInstanceOf(EmailRetryableError);
      expect(recipients()).toEqual(["owner-a@example.com", "owner-b@example.com"]);
      expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();

      sendEmailMock.mockClear();
      await run();
      expect(recipients()).toEqual(["owner-a@example.com"]);
    });
  });
});

// R44 platform L1: in the 04:45 sweep, refresh-connection's notify-owners and
// the sweep's own connection notices can tell the same owner at once. A claim
// still in flight is not "owner reached": the second path records nothing, so
// when the first send then fails, the next sweep still sends.
describe("two paths at once under the same claim", () => {
  const TRY_LATER = { sent: false, reason: "try_later" } as const;
  const recipients = () => sendEmailMock.mock.calls.map((call) => call[0].to);

  /** The first send waits until `finish` is called with its answer (or an error to throw). */
  function holdFirstSend(): { finish: (answer: { sent: boolean; reason?: string } | Error) => void } {
    const held: { finish?: (answer: { sent: boolean; reason?: string } | Error) => void } = {};
    sendEmailMock.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          held.finish = (answer) => (answer instanceof Error ? reject(answer) : resolve(answer));
        }),
    );
    return {
      finish: (answer) => {
        if (!held.finish) throw new Error("the first send has not started");
        held.finish(answer);
      },
    };
  }

  beforeEach(() => membersFindManyMock.mockResolvedValue([OWNERS[0]]));

  describe("reconnect email", () => {
    beforeEach(() => row("conn-1", { needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - DAY_MS) }));

    it.each([
      ["a quota answer", TRY_LATER],
      ["a 5xx", new EmailRetryableError("Resend send failed (status 503)")],
    ])("the first is in flight and then fails (%s): the second records nothing, and the next sweep sends", async (_name, failure) => {
      const first = holdFirstSend();
      const notify = notifyOwnersToReconnect("conn-1", DAY);
      await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(1));

      expect(await sendConnectionNotices(NOW.toISOString(), DAY)).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
      expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();

      first.finish(failure);
      if (failure instanceof Error) await expect(notify).rejects.toBe(failure);
      else await expect(notify).resolves.toEqual({ emailed: 0 });
      expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();

      sendEmailMock.mockClear();
      expect(await sendConnectionNotices(NOW.toISOString(), "2026-11-15")).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 1 });
      expect(recipients()).toEqual(["owner-a@example.com"]);
      expect(table.get("conn-1")!.reconnectEmailedAt).not.toBeNull();
    });

    it("a confirmed earlier send still counts as done: recorded, nobody emailed twice", async () => {
      const first = holdFirstSend();
      const notify = notifyOwnersToReconnect("conn-1", DAY);
      await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(1));
      first.finish({ sent: true });
      await notify;
      table.get("conn-1")!.reconnectEmailedAt = null;

      sendEmailMock.mockClear();
      await sendConnectionNotices(NOW.toISOString(), DAY);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(table.get("conn-1")!.reconnectEmailedAt).not.toBeNull();
    });
  });

  describe("expiry warning", () => {
    const expiresAt = new Date("2026-11-20T15:30:00.000Z");
    beforeEach(() => row("conn-1", { expiresAt }));

    it("the first is in flight and then fails: the second records nothing, and the next sweep sends", async () => {
      const first = holdFirstSend();
      const sweep = sendConnectionNotices(NOW.toISOString(), DAY);
      await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(1));

      expect(await sendConnectionNotices(NOW.toISOString(), DAY)).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
      expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();

      first.finish(TRY_LATER);
      await expect(sweep).resolves.toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
      expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();

      sendEmailMock.mockClear();
      expect(await sendConnectionNotices(NOW.toISOString(), "2026-11-15")).toEqual({ warned: 1, lapsed: 0, reconnectEmails: 0 });
      expect(recipients()).toEqual(["owner-a@example.com"]);
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    });

    it("a confirmed earlier send still counts as done", async () => {
      await sendConnectionNotices(NOW.toISOString(), DAY);
      table.get("conn-1")!.expiryWarnedFor = null;
      sendEmailMock.mockClear();
      await sendConnectionNotices(NOW.toISOString(), DAY);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    });
  });
});

// R44 lead review: an unmarked claim older than any send can take (one from
// before the reached mark existed, a failed mark write, a crash after the send)
// counts as reached; a young one is still sending.
describe("an unmarked claim, by its age", () => {
  const MIN = 60 * 1000;
  const FLAG = new Date(NOW.getTime() - DAY_MS);
  const ownerKey = `connection-reconnect-owner:conn-1:${FLAG.toISOString()}:user-a`;

  beforeEach(() => {
    membersFindManyMock.mockResolvedValue([OWNERS[0]]);
    row("conn-1", { needsReconnect: true, refreshFailedAt: FLAG });
  });

  it("20 minutes old: reached, so the notice stamps and nobody is emailed", async () => {
    claims.set(ownerKey, new Date(NOW.getTime() + 30 * DAY_MS - 20 * MIN));
    await sendConnectionNotices(NOW.toISOString(), DAY);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
  });

  it("1 minute old: still sending, so nothing stamps", async () => {
    claims.set(ownerKey, new Date(NOW.getTime() + 30 * DAY_MS - MIN));
    await sendConnectionNotices(NOW.toISOString(), DAY);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(table.get("conn-1")!.reconnectEmailedAt).toBeNull();
  });

  it("a marked claim reads as reached", async () => {
    claims.set(ownerKey, new Date(NOW.getTime() + 30 * DAY_MS - MIN));
    reached.add(`${ownerKey}:reached`);
    await sendConnectionNotices(NOW.toISOString(), DAY);
    expect(time(table.get("conn-1")!.reconnectEmailedAt)).toBe(NOW.getTime());
  });

  it("the expiry warning's due-date window: an unmarked claim stays held, whatever its age", async () => {
    const expiresAt = new Date("2026-11-20T15:30:00.000Z");
    table.clear();
    row("conn-1", { expiresAt });
    claims.set(`connection-expiry-owner:conn-1:${expiresAt.toISOString()}:user-a`, expiresAt);
    await sendConnectionNotices(NOW.toISOString(), DAY);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(table.get("conn-1")!.expiryWarnedFor).toBeNull();
  });
});

describe("sendConnectionNotices", () => {
  const run = () => sendConnectionNotices(NOW.toISOString(), DAY);

  it("finds the expiry candidates with the shared WHERE and never loads a token", async () => {
    await run();

    const call = findManyMock.mock.calls.find((c) => c[0].where.needsReconnect === false)![0];
    expect(call.where).toEqual(expiryNoticeWhere(NOW));
    expect(call.take).toBe(CONNECTION_NOTICES_BATCH);
    expect(Object.keys(call.select)).not.toContain("accessToken");
    expect(Object.keys(call.select)).not.toContain("refreshToken");
  });

  it("WARNING: a LinkedIn sign-in that ends within 7 days is announced to each owner once, dated in their zone", async () => {
    const expiresAt = new Date("2026-11-20T15:30:00.000Z");
    row("conn-1", { expiresAt });

    expect(await run()).toEqual({ warned: 1, lapsed: 0, reconnectEmails: 0 });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: "owner-a@example.com",
      subject: "LinkedIn needs reconnecting by Friday, November 20, 2026 (Acme)",
    });
    expect(sendEmailMock.mock.calls[1][0].subject).toBe(
      "LinkedIn needs reconnecting by Friday, November 20, 2026 (UTC) (Acme)",
    );
    expect(sendEmailMock.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: "expiry-warning/conn-1/2026-11-20T15:30:00.000Z/user-a", throwOnRetryable: true },
      { idempotencyKey: "expiry-warning/conn-1/2026-11-20T15:30:00.000Z/user-b", throwOnRetryable: true },
    ]);
    expect(membersFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true, timeZone: true } } },
    });
    // Recorded against THIS expiry, so the next sweep sends nothing.
    expect(time(table.get("conn-1")!.expiryWarnedFor)).toBe(expiresAt.getTime());
    sendEmailMock.mockClear();
    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("no warning while more than 7 days are left, nor for a renewable or Page-token connection", async () => {
    row("later", { expiresAt: new Date(NOW.getTime() + 8 * DAY_MS) });
    row("renewable", { refreshToken: "refresh-token", expiresAt: new Date(NOW.getTime() + DAY_MS) });
    row("ig", { platform: "instagram", expiresAt: new Date(NOW.getTime() - DAY_MS) });
    row("fb", { platform: "facebook_page", expiresAt: new Date(NOW.getTime() + DAY_MS) });

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("LAPSED: the sign-in ended: the connection is flagged (only if unchanged) and the owners get the reconnect email", async () => {
    const expiresAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    row("conn-1", { expiresAt, expiryWarnedFor: expiresAt });

    expect(await run()).toEqual({ warned: 0, lapsed: 1, reconnectEmails: 2 });

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "conn-1", needsReconnect: false, refreshToken: null, expiresAt },
      data: { needsReconnect: true, lastRefreshErrorCode: CONNECTION_EXPIRED_CODE, refreshFailedAt: NOW },
    });
    expect(table.get("conn-1")!.needsReconnect).toBe(true);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe("Action needed: reconnect LinkedIn in Acme");
    expect(sendEmailMock.mock.calls[0][0].html).toContain("its sign-in expired");
    // Once: tomorrow's sweep sends nothing more.
    sendEmailMock.mockClear();
    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("LAPSED but reconnected since it was read: nothing is flagged", async () => {
    const expiresAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    row("conn-1", { expiresAt });
    findManyMock.mockImplementationOnce(async () => {
      const read = [{ ...table.get("conn-1")! }];
      table.get("conn-1")!.expiresAt = new Date(NOW.getTime() + 60 * DAY_MS); // the reconnect
      return read;
    });

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
    expect(table.get("conn-1")!.needsReconnect).toBe(false);
  });

  // The already_flagged path: a failed post (Graph 190, a 401) flags without the
  // reconnect email; the sweep never refreshes a flagged connection, so this is
  // the only place its owners hear about it.
  it("FLAGGED BY A POST: every flagged connection without its email gets it once", async () => {
    row("ig-dead", { platform: "instagram", needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - DAY_MS) });
    row("told", {
      needsReconnect: true,
      refreshFailedAt: new Date(NOW.getTime() - 3 * DAY_MS),
      reconnectEmailedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 2 });

    expect(sendEmailMock.mock.calls.map((call) => call[0].subject)).toEqual([
      "Action needed: reconnect Instagram in Acme",
      "Action needed: reconnect Instagram in Acme",
    ]);
    // A plain WHERE and a plain sort (no column reference): newest flags first,
    // compared with their email time in code.
    const call = findManyMock.mock.calls.find((c) => c[0].where.needsReconnect === true)![0];
    expect(call).toEqual({
      where: { needsReconnect: true, refreshFailedAt: { not: null } },
      select: { id: true, refreshFailedAt: true, reconnectEmailedAt: true },
      orderBy: { refreshFailedAt: "desc" },
      take: CONNECTION_FLAG_SCAN_LIMIT,
    });
  });

  it("finds a new flag behind a full page of older flags that were already told", async () => {
    for (let i = 0; i < CONNECTION_FLAG_SCAN_LIMIT; i++) {
      row(`old-${String(i).padStart(4, "0")}`, {
        needsReconnect: true,
        refreshFailedAt: new Date(NOW.getTime() - (10 + i) * DAY_MS),
        reconnectEmailedAt: new Date(NOW.getTime() - (9 + i) * DAY_MS),
      });
    }
    row("new", { needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - 60_000) });

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 2 });
    expect(sendEmailMock.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
      "reconnect/new/2026-11-14/user-a",
      "reconnect/new/2026-11-14/user-b",
    ]);
  });

  it("emails at most CONNECTION_NOTICES_BATCH flags a day; the rest go tomorrow", async () => {
    for (let i = 0; i < CONNECTION_NOTICES_BATCH + 5; i++) {
      row(`n-${String(i).padStart(4, "0")}`, { needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - i * 1000) });
    }
    membersFindManyMock.mockResolvedValue([OWNERS[0]]);

    expect((await run()).reconnectEmails).toBe(CONNECTION_NOTICES_BATCH);
    sendEmailMock.mockClear();
    expect((await run()).reconnectEmails).toBe(5);
  });

  it("a flag with no recorded time (from before the time existed) is not scanned: the release marked those told", async () => {
    row("legacy", { needsReconnect: true, refreshFailedAt: null, reconnectEmailedAt: null });

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 0 });
  });

  it("a retryable send error fails the step; the retry skips what was already recorded", async () => {
    row("a", { needsReconnect: true, refreshFailedAt: NOW });
    row("b", { needsReconnect: true, refreshFailedAt: NOW });
    sendEmailMock
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce({ sent: true })
      .mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 429)"));

    await expect(run()).rejects.toBeInstanceOf(EmailRetryableError);
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ sent: true });

    // R43 review: owner-b of "b" was still tried and reached; only owner-a is left.
    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 1 });
    expect(sendEmailMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      "reconnect/b/2026-11-14/user-a",
    ]);
  });

  it("returns counts only (no tokens, ids or addresses)", async () => {
    row("conn-1", { expiresAt: new Date(NOW.getTime() + DAY_MS) });

    const out = await run();

    expect(Object.keys(out).sort()).toEqual(["lapsed", "reconnectEmails", "warned"]);
  });
});

// R24 pages L4: the client line follows what Settings' connect-link group shows
// for the workspace (clientLinkPanelStatus), from the workspace row already read.
describe("the client line follows the workspace's client links", () => {
  const PAST = new Date(NOW.getTime() - 10 * DAY_MS);
  const FUTURE = new Date(NOW.getTime() + 20 * DAY_MS);
  const cases = [
    { name: "billing off", billing: "", ws: { name: "Acme", plan: "starter", planStatus: "active", currentPeriodEnd: FUTURE }, line: "send them a connect link that offers LinkedIn" },
    { name: "Growth", billing: "true", ws: { name: "Acme", plan: "growth", planStatus: "active", currentPeriodEnd: FUTURE }, line: "send them a connect link that offers LinkedIn" },
    { name: "Starter", billing: "true", ws: { name: "Acme", plan: "starter", planStatus: "active", currentPeriodEnd: FUTURE }, line: "connect links are part of the Growth and Pro plans" },
    { name: "an ended trial", billing: "true", ws: { name: "Acme", plan: null, trialEndsAt: PAST }, line: "Your free trial has ended. Choose Growth or Pro in Settings and your client links work again" },
    { name: "paused", billing: "", ws: { name: "Acme", pausedAt: PAST, pausedReason: null }, line: "Client links don't work right now. This workspace is paused." },
  ];

  for (const { name, billing, ws, line } of cases) {
    it(`${name}: both emails say what Settings says`, async () => {
      vi.stubEnv("BILLING_ENABLED", billing);
      workspaceFindUniqueMock.mockResolvedValue(ws);

      row("flagged", { needsReconnect: true, refreshFailedAt: new Date(NOW.getTime() - DAY_MS) });
      await notifyOwnersToReconnect("flagged", DAY);
      row("soon", { expiresAt: new Date("2026-11-20T15:30:00.000Z") });
      table.delete("flagged");
      await sendConnectionNotices(NOW.toISOString(), DAY);

      expect(sendEmailMock).toHaveBeenCalledTimes(4);
      for (const [email] of sendEmailMock.mock.calls) expect(htmlToPlainText(email.html)).toContain(line);
      // One workspace read per connection, the one that was already made.
      for (const [args] of workspaceFindUniqueMock.mock.calls) expect(args.select).toMatchObject({ name: true, pausedAt: true, pausedReason: true });
    });
  }
});
