import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DELETE /api/auth/account with payments configured (21b): the subscriptions
 * of the workspaces the deletion removes are cancelled at Stripe before the
 * transaction. The deletion internals are stubbed; route.test.ts covers them
 * unchanged.
 */
const PLAN = { deleteWorkspaceIds: ["ws_1", "ws_2"], reassign: [], blocked: [] };

const m = vi.hoisted(() => ({
  calls: [] as string[],
  cancel: vi.fn(),
  refusal: vi.fn(),
  deleteRows: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    pendingConnection: { deleteMany: async () => ({ count: 0 }) },
    oAuthHandshake: { deleteMany: async () => ({ count: 0 }) },
    user: { delete: async () => ({}) },
  };
  return {
    prisma: {
      $transaction: async (cb: (t: unknown) => unknown) => {
        m.calls.push("transaction");
        return cb(tx);
      },
    },
  };
});
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "user-1", email: "owner@example.com", passwordHash: null }),
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: async () => false,
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/billing/cancelOnDelete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing/cancelOnDelete")>()),
  cancelSubscriptionsBeforeDelete: m.cancel,
}));
vi.mock("@/server/account/accountDeletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/account/accountDeletion")>()),
  loadAccountDeletion: async () => ({ plan: PLAN, workspaces: [] }),
  accountDeletionRefusal: m.refusal,
}));
vi.mock("@/server/account/deletionPlan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/account/deletionPlan")>()),
  samePlan: () => true,
}));
vi.mock("@/server/account/deleteWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/account/deleteWorkspace")>()),
  lockWorkspaceOwners: async () => {},
  isPostPublishing: async () => false,
  queueWorkspaceFiles: async () => [],
  deleteWorkspaceRows: m.deleteRows,
  deleteQueuedFiles: async () => ({ deleted: 0, left: 0 }),
}));

import { DeletionRefusedError } from "@/server/account/deleteWorkspace";
import { CANCEL_FAILED_MESSAGE } from "@/server/billing/cancelOnDelete";

import { DELETE } from "./route";

const request = () =>
  new Request("https://app.example/api/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmEmail: "owner@example.com" }),
  });

beforeEach(() => {
  m.calls = [];
  m.cancel.mockReset();
  m.cancel.mockImplementation(async () => {
    m.calls.push("cancel");
    return { ok: true, cancelled: 1 };
  });
  m.refusal.mockReset();
  m.refusal.mockResolvedValue(null);
  m.deleteRows.mockReset();
  m.deleteRows.mockImplementation(async () => {
    m.calls.push("delete");
  });
});

describe("DELETE /api/auth/account cancels the plans first", () => {
  it("cancels the subscriptions of every workspace it deletes, before the transaction", async () => {
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(m.cancel).toHaveBeenCalledWith(["ws_1", "ws_2"], { precheck: expect.any(Function) });
    expect(m.calls).toEqual(["cancel", "transaction", "delete"]);
  });

  it("the precheck is the route's own refusal check on the plan", async () => {
    m.refusal.mockResolvedValue("A post is publishing right now. Try again in a few minutes.");
    await DELETE(request());
    const { precheck } = m.cancel.mock.calls[0][1];
    expect(await precheck()).toBe("A post is publishing right now. Try again in a few minutes.");
    expect(m.refusal).toHaveBeenCalledWith(PLAN);
  });

  it("when Stripe refuses, deletes nothing and says so", async () => {
    m.cancel.mockResolvedValue({ ok: false, status: 502, error: CANCEL_FAILED_MESSAGE });
    const res = await DELETE(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: CANCEL_FAILED_MESSAGE });
    expect(m.calls).not.toContain("transaction");
  });

  it("when the delete fails after a cancel, says the plan was cancelled", async () => {
    m.deleteRows.mockRejectedValue(new Error("database unavailable"));
    const res = await DELETE(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Your plan was cancelled but your account could not be deleted. Try again." });
  });

  it("when the transaction refuses after a cancel, says the plan was cancelled and why", async () => {
    m.deleteRows.mockRejectedValue(new DeletionRefusedError("A post is publishing right now. Try again in a few minutes."));
    const res = await DELETE(request());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Your plan was cancelled but your account could not be deleted. A post is publishing right now. Try again in a few minutes.",
    );
  });

  it("with nothing cancelled, a failed delete keeps today's message", async () => {
    m.cancel.mockResolvedValue({ ok: true, cancelled: 0 });
    m.deleteRows.mockRejectedValue(new Error("database unavailable"));
    const res = await DELETE(request());
    expect(await res.json()).toEqual({ error: "Could not delete your account. Nothing was changed. Try again." });
  });
});
