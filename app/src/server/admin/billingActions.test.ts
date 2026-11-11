import { beforeEach, describe, expect, it, vi } from "vitest";

/** 21a: the operator's two billing changes, recorded like the limits and the pause. */

const db = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceUpdate: vi.fn(),
  actionCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    $executeRaw: db.executeRaw,
    workspace: { findUnique: db.workspaceFindUnique, update: db.workspaceUpdate },
    adminAction: { create: db.actionCreate },
  };
  return {
    prisma: {
      $transaction: (callback: (client: unknown) => unknown) => {
        db.transaction();
        return callback(tx);
      },
    },
  };
});

import { setBillingExempt, setTrialEndsAt, validateExemptBody, validateTrialBody } from "./actions";

const OPS = { userId: "op-1", email: "ops@example.com" };
const NOW = new Date("2026-11-10T12:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    name: "Surf Co",
    limitPostsPerDay: null,
    limitXPostsPerMonth: null,
    limitYoutubeUploadsPerDay: null,
    limitStorageMb: null,
    pausedAt: null,
    pausedReason: null,
    billingExempt: false,
    trialEndsAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.workspaceUpdate.mockResolvedValue({});
  db.actionCreate.mockResolvedValue({ id: "act-1" });
});

describe("validateExemptBody", () => {
  it("takes true or false, nothing else", () => {
    expect(validateExemptBody({ exempt: true })).toEqual({ ok: true, exempt: true });
    expect(validateExemptBody({ exempt: false })).toEqual({ ok: true, exempt: false });
    for (const body of [{}, { exempt: "true" }, { exempt: 1 }, { exempt: null }, null, [], { exempt: true, x: 1 }]) {
      expect(validateExemptBody(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("validateTrialBody", () => {
  it("takes a date from today to 90 days ahead, as the end of that UTC day", () => {
    expect(validateTrialBody({ trialEndsAt: "2026-11-10" }, NOW)).toEqual({
      ok: true,
      trialEndsAt: new Date("2026-11-10T23:59:59.999Z"),
    });
    expect(validateTrialBody({ trialEndsAt: "2027-02-08" }, NOW)).toEqual({
      ok: true,
      trialEndsAt: new Date("2027-02-08T23:59:59.999Z"),
    });
  });

  it("takes null to clear it", () => {
    expect(validateTrialBody({ trialEndsAt: null }, NOW)).toEqual({ ok: true, trialEndsAt: null });
  });

  it("refuses a past date, one more than 90 days ahead, and anything not a date", () => {
    expect(validateTrialBody({ trialEndsAt: "2026-11-09" }, NOW)).toEqual({
      ok: false,
      error: "Pick today or a later date.",
    });
    expect(validateTrialBody({ trialEndsAt: "2027-02-09" }, NOW)).toEqual({
      ok: false,
      error: "Pick a date at most 90 days ahead (8 February 2027 or earlier).",
    });
    for (const value of [undefined, "", "tomorrow", "2026-11-31", "2026-11-20T00:00:00Z", 20261120, true]) {
      expect(validateTrialBody({ trialEndsAt: value }, NOW).ok, String(value)).toBe(false);
    }
    expect(validateTrialBody(null, NOW).ok).toBe(false);
    expect(validateTrialBody({ trialEndsAt: null, other: 1 }, NOW).ok).toBe(false);
  });
});

describe("setBillingExempt", () => {
  it("sets it in one transaction, under the row lock, and records old and new", async () => {
    db.workspaceFindUnique.mockResolvedValue(row());

    expect(await setBillingExempt({ operator: OPS, workspaceId: "ws-1", exempt: true })).toEqual({ status: "changed" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.workspaceFindUnique.mock.invocationCallOrder[0]);
    expect(db.workspaceFindUnique.mock.calls[0][0].select).toMatchObject({ billingExempt: true, trialEndsAt: true });
    expect(db.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { billingExempt: true } });
    expect(db.actionCreate).toHaveBeenCalledWith({
      data: {
        operatorUserId: "op-1",
        operatorEmail: "ops@example.com",
        workspaceId: "ws-1",
        workspaceName: "Surf Co",
        action: "exempt",
        detail: { old: { billingExempt: false }, new: { billingExempt: true } },
      },
      select: { id: true },
    });
  });

  it("clears it", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ billingExempt: true }));
    await setBillingExempt({ operator: OPS, workspaceId: "ws-1", exempt: false });
    expect(db.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { billingExempt: false } });
    expect(db.actionCreate.mock.calls[0][0].data.detail).toEqual({
      old: { billingExempt: true },
      new: { billingExempt: false },
    });
  });

  it("writes and records nothing when it is already so, and answers not found for no workspace", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ billingExempt: true }));
    expect(await setBillingExempt({ operator: OPS, workspaceId: "ws-1", exempt: true })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await setBillingExempt({ operator: OPS, workspaceId: "x", exempt: true })).toEqual({ status: "not_found" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});

describe("setTrialEndsAt", () => {
  const END = new Date("2026-12-01T23:59:59.999Z");

  it("sets it in one transaction and records old and new", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date("2026-11-20T00:00:00Z") }));

    expect(await setTrialEndsAt({ operator: OPS, workspaceId: "ws-1", trialEndsAt: END })).toEqual({ status: "changed" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(db.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { trialEndsAt: END } });
    expect(db.actionCreate.mock.calls[0][0].data).toMatchObject({
      action: "trial",
      detail: { old: { trialEndsAt: "2026-11-20T00:00:00.000Z" }, new: { trialEndsAt: END.toISOString() } },
    });
  });

  it("clears it", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: END }));
    await setTrialEndsAt({ operator: OPS, workspaceId: "ws-1", trialEndsAt: null });
    expect(db.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { trialEndsAt: null } });
    expect(db.actionCreate.mock.calls[0][0].data.detail).toEqual({
      old: { trialEndsAt: END.toISOString() },
      new: { trialEndsAt: null },
    });
  });

  it("writes and records nothing when it is the same, and answers not found for no workspace", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date(END) }));
    expect(await setTrialEndsAt({ operator: OPS, workspaceId: "ws-1", trialEndsAt: END })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(row());
    expect(await setTrialEndsAt({ operator: OPS, workspaceId: "ws-1", trialEndsAt: null })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await setTrialEndsAt({ operator: OPS, workspaceId: "x", trialEndsAt: END })).toEqual({ status: "not_found" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});
