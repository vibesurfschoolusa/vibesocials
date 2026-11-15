import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: m.findMany } } }));

import { payerRefusal } from "./payerRefusal";

/**
 * R5-security L2: leaving a workspace, or deleting the account, must not leave
 * the person's card paying for a workspace that carries on without them. The
 * payer is the workspace's billingUserId, recorded when checkout starts.
 */

const ENV = { BILLING_ENABLED: "true" };

const running = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Name of ${id}`,
  planStatus: "active",
  billingUserId: "user-1",
  ...overrides,
});

beforeEach(() => {
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([running("ws_1")]);
});

describe("payerRefusal", () => {
  it("refuses the person recorded as paying, naming the workspace", async () => {
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV)).resolves.toEqual({
      status: 409,
      error: "You pay for Name of ws_1's plan. Cancel it under Settings, Plan first (it stays active until the end of the period); another owner can then start their own plan.",
    });
  });

  it("reads the payer of running plans not set to end, among the workspaces that survive", async () => {
    await payerRefusal({ userId: "user-1", workspaceIds: ["ws_1", "ws_2"] }, ENV);
    expect(m.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["ws_1", "ws_2"] },
        billingUserId: "user-1",
        stripeSubscriptionId: { not: null },
        planEndsAt: null,
      },
      select: { id: true, name: true, planStatus: true, billingUserId: true },
    });
  });

  it("lets someone else go, and skips a workspace whose payer was never recorded", async () => {
    m.findMany.mockResolvedValue([]);
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
  });

  it("lets the payer go once the plan is no longer live", async () => {
    m.findMany.mockResolvedValue([running("ws_1", { planStatus: "canceled" })]);
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
  });

  it("does nothing with billing off or with no workspace", async () => {
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, {})).resolves.toBeNull();
    await expect(payerRefusal({ userId: "user-1", workspaceIds: [] }, ENV)).resolves.toBeNull();
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
