import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DELETE /api/workspaces/active with payments configured (21b): the
 * subscription is cancelled at Stripe before the deletion transaction. The
 * deletion internals are stubbed; route.test.ts covers them unchanged.
 */
const m = vi.hoisted(() => ({
  calls: [] as string[],
  cancel: vi.fn(),
  refusal: vi.fn(),
  deleteRows: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = { workspaceMember: { findMany: async () => [] }, $executeRaw: async () => 0 };
  return {
    prisma: {
      $transaction: async (cb: (t: unknown) => unknown) => {
        m.calls.push("transaction");
        return cb(tx);
      },
    },
  };
});
vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
  requireOwnerContext: async () => ({
    user: { id: "user-1", email: "owner@example.com" },
    workspace: { id: "ws_1", name: "Surf Co" },
    role: "owner",
  }),
  provisionPersonalWorkspace: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/billing/cancelOnDelete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing/cancelOnDelete")>()),
  cancelSubscriptionsBeforeDelete: m.cancel,
}));
vi.mock("@/server/account/deleteWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/account/deleteWorkspace")>()),
  lockWorkspaceOwners: async () => {},
  workspaceDeletionRefusal: m.refusal,
  queueWorkspaceFiles: async () => [],
  deleteWorkspaceRows: m.deleteRows,
  deleteQueuedFiles: async () => ({ deleted: 0, left: 0 }),
}));

import { DeletionRefusedError } from "@/server/account/deleteWorkspace";
import { CANCEL_FAILED_MESSAGE } from "@/server/billing/cancelOnDelete";

import { DELETE } from "./route";

const request = () =>
  new Request("https://app.example/api/workspaces/active", {
    method: "DELETE",
    body: JSON.stringify({ confirmName: "Surf Co" }),
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

describe("DELETE /api/workspaces/active cancels the plan first", () => {
  it("cancels this workspace's subscription before the transaction", async () => {
    const res = await DELETE(request());
    expect(res.status).toBe(200);
    expect(m.cancel).toHaveBeenCalledWith(["ws_1"], { precheck: expect.any(Function) });
    expect(m.calls).toEqual(["cancel", "transaction", "delete"]);
  });

  it("the precheck is the route's own refusal check", async () => {
    m.refusal.mockResolvedValue("This is your only workspace. To leave Vibe Socials, delete your account instead.");
    await DELETE(request());
    const { precheck } = m.cancel.mock.calls[0][1];
    expect(await precheck()).toBe("This is your only workspace. To leave Vibe Socials, delete your account instead.");
    expect(m.refusal).toHaveBeenCalledWith("ws_1", "user-1");
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
    expect(await res.json()).toEqual({ error: "Your plan was cancelled but the workspace could not be deleted. Try again." });
  });

  it("when the transaction refuses after a cancel, says the plan was cancelled and why", async () => {
    m.deleteRows.mockRejectedValue(new DeletionRefusedError("A post is publishing right now. Try again in a few minutes."));
    const res = await DELETE(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "Your plan was cancelled but the workspace could not be deleted. A post is publishing right now. Try again in a few minutes.",
    });
  });

  it("with nothing cancelled, a failed delete keeps today's message", async () => {
    m.cancel.mockResolvedValue({ ok: true, cancelled: 0 });
    m.deleteRows.mockRejectedValue(new Error("database unavailable"));
    const res = await DELETE(request());
    expect(await res.json()).toEqual({ error: "Could not delete this workspace. Nothing was changed. Try again." });
  });
});
