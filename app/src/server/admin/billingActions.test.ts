import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 21a (fix round 1): the operator's two billing changes, recorded like the
 * limits and the pause: "Exempt this workspace" and "Start or change the
 * trial". There is no clearing a trial: that would make it exempt by rule.
 */

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

import { planState } from "@/lib/billing";

import { endTrialNow, exemptWorkspace, startTrial, validateTrialBody } from "./actions";

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

describe("validateTrialBody", () => {
  it("takes a date from tomorrow to 90 days ahead (UTC), as the end of that UTC day", () => {
    expect(validateTrialBody({ trialEndsAt: "2026-11-11" }, NOW)).toEqual({
      ok: true,
      trialEndsAt: new Date("2026-11-11T23:59:59.999Z"),
    });
    expect(validateTrialBody({ trialEndsAt: "2027-02-08" }, NOW)).toEqual({
      ok: true,
      trialEndsAt: new Date("2027-02-08T23:59:59.999Z"),
    });
  });

  it("judges today by the UTC date, not the operator's", () => {
    // 23:30 UTC on the 10th is still the 10th: the 11th is tomorrow and accepted.
    const lateUtc = new Date("2026-11-10T23:30:00Z");
    expect(validateTrialBody({ trialEndsAt: "2026-11-11" }, lateUtc).ok).toBe(true);
    expect(validateTrialBody({ trialEndsAt: "2026-11-10" }, lateUtc).ok).toBe(false);
  });

  it("refuses today and yesterday with a pointer to End the trial now", () => {
    const refusal = {
      ok: false,
      error: 'Pick a date after today (UTC). To end the trial today, use "End the trial now".',
    };
    expect(validateTrialBody({ trialEndsAt: "2026-11-10" }, NOW)).toEqual(refusal);
    expect(validateTrialBody({ trialEndsAt: "2026-11-09" }, NOW)).toEqual(refusal);
  });

  it("refuses 91 days ahead, null, and anything not a date", () => {
    expect(validateTrialBody({ trialEndsAt: "2027-02-09" }, NOW)).toEqual({
      ok: false,
      error: "Pick a date at most 90 days ahead (8 February 2027 or earlier).",
    });
    for (const value of [null, undefined, "", "tomorrow", "2026-11-31", "2026-11-20T00:00:00Z", 20261120, true]) {
      expect(validateTrialBody({ trialEndsAt: value }, NOW).ok, String(value)).toBe(false);
    }
    expect(validateTrialBody(null, NOW).ok).toBe(false);
    expect(validateTrialBody({ trialEndsAt: "2026-11-20", other: 1 }, NOW).ok).toBe(false);
  });
});

describe("exemptWorkspace", () => {
  it("sets billingExempt in one transaction, under the row lock, and records old and new", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date("2026-11-01T00:00:00Z") }));

    expect(await exemptWorkspace({ operator: OPS, workspaceId: "ws-1" })).toEqual({ status: "changed" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.workspaceFindUnique.mock.invocationCallOrder[0]);
    expect(db.workspaceFindUnique.mock.calls[0][0].select).toMatchObject({ billingExempt: true, trialEndsAt: true });
    // Nothing else: the trial date stays as it was.
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

  it("writes and records nothing when already exempt, and answers not found for no workspace", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ billingExempt: true }));
    expect(await exemptWorkspace({ operator: OPS, workspaceId: "ws-1" })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await exemptWorkspace({ operator: OPS, workspaceId: "x" })).toEqual({ status: "not_found" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});

describe("startTrial", () => {
  const END = new Date("2026-12-01T23:59:59.999Z");

  it("sets billingExempt false and the trial end in one transaction, and records old and new", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ billingExempt: true, trialEndsAt: null }));

    expect(await startTrial({ operator: OPS, workspaceId: "ws-1", trialEndsAt: END })).toEqual({ status: "changed" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { billingExempt: false, trialEndsAt: END },
    });
    expect(db.actionCreate.mock.calls[0][0].data).toMatchObject({
      action: "trial",
      detail: {
        old: { billingExempt: true, trialEndsAt: null },
        new: { billingExempt: false, trialEndsAt: END.toISOString() },
      },
    });
  });

  it("changes the date of a running trial", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date("2026-11-20T23:59:59.999Z") }));
    await startTrial({ operator: OPS, workspaceId: "ws-1", trialEndsAt: END });
    expect(db.actionCreate.mock.calls[0][0].data.detail).toEqual({
      old: { billingExempt: false, trialEndsAt: "2026-11-20T23:59:59.999Z" },
      new: { billingExempt: false, trialEndsAt: END.toISOString() },
    });
  });

  it("writes and records nothing when it is already so, and answers not found for no workspace", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date(END) }));
    expect(await startTrial({ operator: OPS, workspaceId: "ws-1", trialEndsAt: END })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await startTrial({ operator: OPS, workspaceId: "x", trialEndsAt: END })).toEqual({ status: "not_found" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });

  it("a trial started on an exempt workspace ends when its date passes; exempting it again makes it exempt", async () => {
    const stored: Record<string, unknown> = row({ billingExempt: true, trialEndsAt: null });
    db.workspaceFindUnique.mockImplementation(async () => ({ ...stored }));
    db.workspaceUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => Object.assign(stored, data));

    const tomorrow = validateTrialBody({ trialEndsAt: "2026-11-11" }, NOW);
    if (!tomorrow.ok) throw new Error(tomorrow.error);
    await startTrial({ operator: OPS, workspaceId: "ws-1", trialEndsAt: tomorrow.trialEndsAt });
    expect(planState(stored, NOW)).toBe("trial");
    expect(planState(stored, new Date("2026-11-12T00:00:00Z"))).toBe("ended");

    await exemptWorkspace({ operator: OPS, workspaceId: "ws-1" });
    expect(planState(stored, new Date("2026-11-12T00:00:00Z"))).toBe("exempt");
  });
});

describe("endTrialNow", () => {
  it("ends a running trial at this instant, in one transaction, and records old and new", async () => {
    const running = new Date("2026-11-20T23:59:59.999Z");
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: running }));

    expect(await endTrialNow({ operator: OPS, workspaceId: "ws-1", now: NOW })).toEqual({ status: "changed" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { billingExempt: false, trialEndsAt: NOW },
    });
    expect(db.actionCreate.mock.calls[0][0].data).toMatchObject({
      action: "trial",
      detail: {
        old: { billingExempt: false, trialEndsAt: running.toISOString() },
        new: { billingExempt: false, trialEndsAt: NOW.toISOString() },
      },
    });
    expect(planState({ billingExempt: false, trialEndsAt: NOW }, NOW)).toBe("ended");
  });

  it("ends an exempt workspace's exemption, with an ended trial", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ billingExempt: true, trialEndsAt: null }));
    expect(await endTrialNow({ operator: OPS, workspaceId: "ws-1", now: NOW })).toEqual({ status: "changed" });
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { billingExempt: false, trialEndsAt: NOW },
    });
    expect(db.actionCreate.mock.calls[0][0].data.detail).toEqual({
      old: { billingExempt: true, trialEndsAt: null },
      new: { billingExempt: false, trialEndsAt: NOW.toISOString() },
    });
  });

  it("changes and records nothing for a trial that has already ended, and answers not found for no workspace", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: new Date("2026-11-01T00:00:00Z") }));
    expect(await endTrialNow({ operator: OPS, workspaceId: "ws-1", now: NOW })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(row({ trialEndsAt: NOW }));
    expect(await endTrialNow({ operator: OPS, workspaceId: "ws-1", now: NOW })).toEqual({ status: "unchanged" });
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await endTrialNow({ operator: OPS, workspaceId: "x", now: NOW })).toEqual({ status: "not_found" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});
