import type { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R5-publishing M1: no connection may die unannounced. The daily sweep's last
// step warns a week before a sign-in that cannot be renewed lapses, flags it
// when it has, and emails the owners of every flagged connection that has not
// had its reconnect email (a failed post flags without one). An in-memory table
// stands in for SocialConnection; no database, Resend or Inngest is reached.
const {
  table,
  REFRESH_FAILED_AT_REF,
  findManyMock,
  findUniqueMock,
  updateManyMock,
  workspaceFindUniqueMock,
  membersFindManyMock,
  sendEmailMock,
} = vi.hoisted(() => ({
    table: new Map<string, Record<string, unknown>>(),
    // Stands in for `prisma.socialConnection.fields.refreshFailedAt` (a column reference).
    REFRESH_FAILED_AT_REF: { name: "refreshFailedAt", modelName: "SocialConnection" },
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
      fields: { refreshFailedAt: REFRESH_FAILED_AT_REF },
    },
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: membersFindManyMock },
  },
}));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: sendEmailMock,
}));

import { EmailRetryableError } from "@/server/notifications/email";
import { expiryNoticeWhere } from "./connectionHealthSweep";
import {
  CONNECTION_EXPIRED_CODE,
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
    if (c.lt !== undefined) {
      const bound = c.lt === REFRESH_FAILED_AT_REF ? r.refreshFailedAt : c.lt;
      if (value === null || bound === null || !(time(value)! < time(bound)!)) return false;
    }
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
  for (const mock of [findManyMock, findUniqueMock, updateManyMock, workspaceFindUniqueMock, membersFindManyMock, sendEmailMock]) {
    mock.mockReset();
  }
  findManyMock.mockImplementation(
    async (args: { where: Record<string, unknown>; select: Record<string, boolean>; take: number }) =>
      [...table.values()]
        .filter((r) => matches(r, args.where))
        .slice(0, args.take)
        .map((r) => pick(r, args.select)),
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
  sendEmailMock.mockResolvedValue(undefined);
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
    const call = findManyMock.mock.calls.find((c) => c[0].where.needsReconnect === true)![0];
    expect(call).toEqual({
      where: {
        needsReconnect: true,
        OR: [{ reconnectEmailedAt: null }, { reconnectEmailedAt: { lt: REFRESH_FAILED_AT_REF } }],
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: CONNECTION_NOTICES_BATCH,
    });
  });

  it("a retryable send error fails the step; the retry skips what was already recorded", async () => {
    row("a", { needsReconnect: true, refreshFailedAt: NOW });
    row("b", { needsReconnect: true, refreshFailedAt: NOW });
    sendEmailMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 429)"));

    await expect(run()).rejects.toBeInstanceOf(EmailRetryableError);
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);

    expect(await run()).toEqual({ warned: 0, lapsed: 0, reconnectEmails: 2 });
    expect(sendEmailMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      "reconnect/b/2026-11-14/user-a",
      "reconnect/b/2026-11-14/user-b",
    ]);
  });

  it("returns counts only (no tokens, ids or addresses)", async () => {
    row("conn-1", { expiresAt: new Date(NOW.getTime() + DAY_MS) });

    const out = await run();

    expect(Object.keys(out).sort()).toEqual(["lapsed", "reconnectEmails", "warned"]);
  });
});
