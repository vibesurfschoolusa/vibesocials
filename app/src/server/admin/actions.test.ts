import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  LIMIT_FIELDS,
  pauseWorkspace,
  resumeWorkspace,
  setWorkspaceLimits,
  validateLimitsBody,
  validatePauseBody,
} from "./actions";

const OPS = { userId: "op-1", email: "ops@example.com" };
const OPS_2 = { userId: "op-2", email: "second@example.com" };
const NOW = new Date("2026-11-10T12:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    name: "Surf Co",
    limitPostsPerDay: null,
    limitXPostsPerMonth: 30,
    limitYoutubeUploadsPerDay: null,
    limitStorageMb: null,
    pausedAt: null,
    pausedReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.workspaceUpdate.mockResolvedValue({});
  db.actionCreate.mockResolvedValue({ id: "act-1" });
});

describe("validateLimitsBody", () => {
  it("accepts numbers within bounds and null for the default", () => {
    expect(
      validateLimitsBody({
        limitPostsPerDay: 0,
        limitXPostsPerMonth: 100_000,
        limitYoutubeUploadsPerDay: null,
        limitStorageMb: 1_000_000,
      }),
    ).toEqual({
      ok: true,
      limits: {
        limitPostsPerDay: 0,
        limitXPostsPerMonth: 100_000,
        limitYoutubeUploadsPerDay: null,
        limitStorageMb: 1_000_000,
      },
    });
    expect(validateLimitsBody({ limitStorageMb: null })).toEqual({ ok: true, limits: { limitStorageMb: null } });
  });

  it.each([
    [{ limitPostsPerDay: -1 }],
    [{ limitPostsPerDay: 100_001 }],
    [{ limitXPostsPerMonth: 1.5 }],
    [{ limitYoutubeUploadsPerDay: "10" }],
    [{ limitStorageMb: 1_000_001 }],
    [{ limitStorageMb: Number.NaN }],
    [{ limitPostsPerDay: 5, somethingElse: 1 }],
    [{}],
    [null],
    [[1]],
  ])("refuses %j", (body) => {
    const result = validateLimitsBody(body);
    expect(result.ok).toBe(false);
  });

  it("names the four override columns", () => {
    expect(LIMIT_FIELDS).toEqual([
      "limitPostsPerDay",
      "limitXPostsPerMonth",
      "limitYoutubeUploadsPerDay",
      "limitStorageMb",
    ]);
  });
});

describe("validatePauseBody", () => {
  it("requires a reason", () => {
    expect(validatePauseBody({}).ok).toBe(false);
    expect(validatePauseBody({ reason: "   " }).ok).toBe(false);
    expect(validatePauseBody({ reason: 5 }).ok).toBe(false);
    expect(validatePauseBody(null).ok).toBe(false);
  });

  it("trims it and allows at most 300 characters of plain text on one line", () => {
    expect(validatePauseBody({ reason: "  Unpaid invoice.  " })).toEqual({ ok: true, reason: "Unpaid invoice." });
    expect(validatePauseBody({ reason: "a".repeat(300) }).ok).toBe(true);
    expect(validatePauseBody({ reason: "a".repeat(301) }).ok).toBe(false);
    expect(validatePauseBody({ reason: "two\nlines" }).ok).toBe(false);
    expect(validatePauseBody({ reason: "bell\u0007" }).ok).toBe(false);
  });
});

describe("setWorkspaceLimits", () => {
  it("sets and clears in one transaction, under the row lock, and records old and new", async () => {
    db.workspaceFindUnique.mockResolvedValue(row());

    const result = await setWorkspaceLimits({
      operator: OPS,
      workspaceId: "ws-1",
      limits: { limitPostsPerDay: 50, limitXPostsPerMonth: null },
    });

    expect(result).toEqual({ status: "changed" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.workspaceFindUnique.mock.invocationCallOrder[0],
    );
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { limitPostsPerDay: 50, limitXPostsPerMonth: null },
    });
    expect(db.actionCreate).toHaveBeenCalledWith({
      data: {
        operatorUserId: "op-1",
        operatorEmail: "ops@example.com",
        workspaceId: "ws-1",
        workspaceName: "Surf Co",
        action: "limits",
        detail: {
          old: { limitPostsPerDay: null, limitXPostsPerMonth: 30 },
          new: { limitPostsPerDay: 50, limitXPostsPerMonth: null },
        },
      },
      select: { id: true },
    });
  });

  it("changes only the keys present, so another operator's edit to a different limit survives", async () => {
    // Another operator set posts per day to 80 after this page was loaded.
    db.workspaceFindUnique.mockResolvedValue(row({ limitPostsPerDay: 80 }));

    await setWorkspaceLimits({ operator: OPS, workspaceId: "ws-1", limits: { limitStorageMb: 2048 } });

    expect(db.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { limitStorageMb: 2048 } });
    expect(db.actionCreate.mock.calls[0][0].data.detail).toEqual({
      old: { limitStorageMb: null },
      new: { limitStorageMb: 2048 },
    });
  });

  it("records a second operator's change under their own email", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ limitPostsPerDay: 50 }));
    await setWorkspaceLimits({ operator: OPS_2, workspaceId: "ws-1", limits: { limitPostsPerDay: 60 } });
    expect(db.actionCreate.mock.calls[0][0].data).toMatchObject({
      operatorUserId: "op-2",
      operatorEmail: "second@example.com",
      detail: { old: { limitPostsPerDay: 50 }, new: { limitPostsPerDay: 60 } },
    });
  });

  it("writes and records nothing when nothing changes", async () => {
    db.workspaceFindUnique.mockResolvedValue(row());
    expect(
      await setWorkspaceLimits({ operator: OPS, workspaceId: "ws-1", limits: { limitXPostsPerMonth: 30 } }),
    ).toEqual({ status: "unchanged" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });

  it("answers not found for a workspace that does not exist", async () => {
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(
      await setWorkspaceLimits({ operator: OPS, workspaceId: "nope", limits: { limitPostsPerDay: 1 } }),
    ).toEqual({ status: "not_found" });
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});

describe("pauseWorkspace", () => {
  it("pauses and records it in one transaction", async () => {
    db.workspaceFindUnique.mockResolvedValue(row());

    const result = await pauseWorkspace({ operator: OPS, workspaceId: "ws-1", reason: "Unpaid invoice.", now: NOW });

    expect(result).toEqual({ status: "changed", actionId: "act-1", workspaceName: "Surf Co" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { pausedAt: NOW, pausedReason: "Unpaid invoice." },
    });
    expect(db.actionCreate.mock.calls[0][0].data).toEqual({
      operatorUserId: "op-1",
      operatorEmail: "ops@example.com",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      action: "pause",
      detail: {
        old: { pausedAt: null, pausedReason: null },
        new: { pausedAt: NOW.toISOString(), pausedReason: "Unpaid invoice." },
      },
    });
  });

  it("changes and records nothing for a workspace already paused", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ pausedAt: NOW, pausedReason: "First." }));
    expect(await pauseWorkspace({ operator: OPS, workspaceId: "ws-1", reason: "Second.", now: NOW })).toEqual({
      status: "unchanged",
    });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });

  it("answers not found for a workspace that does not exist", async () => {
    db.workspaceFindUnique.mockResolvedValue(null);
    expect(await pauseWorkspace({ operator: OPS, workspaceId: "x", reason: "r", now: NOW })).toEqual({
      status: "not_found",
    });
  });
});

describe("resumeWorkspace", () => {
  it("clears the pause and records the old values", async () => {
    db.workspaceFindUnique.mockResolvedValue(row({ pausedAt: NOW, pausedReason: "Unpaid invoice." }));

    const result = await resumeWorkspace({ operator: OPS, workspaceId: "ws-1" });

    expect(result).toEqual({ status: "changed", actionId: "act-1", workspaceName: "Surf Co" });
    expect(db.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { pausedAt: null, pausedReason: null },
    });
    expect(db.actionCreate.mock.calls[0][0].data).toMatchObject({
      action: "resume",
      detail: {
        old: { pausedAt: NOW.toISOString(), pausedReason: "Unpaid invoice." },
        new: { pausedAt: null, pausedReason: null },
      },
    });
  });

  it("changes and records nothing for a workspace that is not paused", async () => {
    db.workspaceFindUnique.mockResolvedValue(row());
    expect(await resumeWorkspace({ operator: OPS, workspaceId: "ws-1" })).toEqual({ status: "unchanged" });
    expect(db.workspaceUpdate).not.toHaveBeenCalled();
    expect(db.actionCreate).not.toHaveBeenCalled();
  });
});
