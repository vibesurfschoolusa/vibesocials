import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: m.findMany, findUnique: m.findUnique } } }));

import { isWorkspacePayer, payerRefusal } from "./payerRefusal";

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
  members: [{ role: "owner" }],
  ...overrides,
});

beforeEach(() => {
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([running("ws_1")]);
});

describe("isWorkspacePayer", () => {
  const RUNNING = { billingUserId: "user-1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", planStatus: "active" };

  it("is true for the person recorded as paying, while their plan is running", async () => {
    m.findUnique.mockResolvedValue(RUNNING);
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(true);
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { id: "ws_1" },
      select: { billingUserId: true, stripeCustomerId: true, stripeSubscriptionId: true, planStatus: true },
    });
    // Set to end at the period's close still runs (and still charges until then).
    m.findUnique.mockResolvedValue({ ...RUNNING, planStatus: "past_due" });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(true);
  });

  // Second review: once the plan has ended there is nothing to pay or cancel,
  // so neither the "You pay for this workspace's plan" line nor the portal shows.
  it("is false once the subscription has ended, or when there is none", async () => {
    m.findUnique.mockResolvedValue({ ...RUNNING, planStatus: "canceled" });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
    m.findUnique.mockResolvedValue({ ...RUNNING, planStatus: "incomplete_expired" });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
    m.findUnique.mockResolvedValue({ ...RUNNING, stripeSubscriptionId: null });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
  });

  it("is false for anyone else, with no payer recorded, or with no customer", async () => {
    m.findUnique.mockResolvedValue(RUNNING);
    await expect(isWorkspacePayer("ws_1", "user-2")).resolves.toBe(false);
    m.findUnique.mockResolvedValue({ ...RUNNING, billingUserId: null });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
    m.findUnique.mockResolvedValue({ ...RUNNING, stripeCustomerId: null });
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
    m.findUnique.mockResolvedValue(null);
    await expect(isWorkspacePayer("ws_1", "user-1")).resolves.toBe(false);
  });
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
      select: {
        id: true,
        name: true,
        planStatus: true,
        billingUserId: true,
        members: { where: { userId: "user-1" }, select: { role: true } },
      },
    });
  });

  // Review: a payer who was made a member has no Plan section, only "Manage your payment".
  it("tells a payer who is no longer an owner to use Manage your payment", async () => {
    m.findMany.mockResolvedValue([running("ws_1", { members: [{ role: "member" }] })]);
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV)).resolves.toEqual({
      status: 409,
      error:
        "You pay for Name of ws_1's plan. Cancel it with Manage your payment in Settings first (it stays active until the end of the period); another owner can then start their own plan.",
    });
  });

  // Review case: payer made a member -> cancels in the portal -> may leave.
  // Cancelling sets planEndsAt (Stripe's webhook), which the query leaves out.
  it("a member payer is refused until the plan is set to end, then may go", async () => {
    m.findMany.mockResolvedValueOnce([running("ws_1", { members: [{ role: "member" }] })]);
    expect((await payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV))?.status).toBe(409);
    m.findMany.mockResolvedValueOnce([]);
    await expect(payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
    expect(m.findMany.mock.calls[1][0].where.planEndsAt).toBeNull();
  });

  // R6-security L1: an owner may not remove the member whose card pays.
  it("refuses removing the payer, with the leaving sentence told to the person removing them", async () => {
    m.findMany.mockResolvedValue([running("ws_1", { members: [{ role: "member" }] })]);
    await expect(
      payerRefusal({ userId: "user-1", workspaceIds: ["ws_1"], removedByOther: true }, ENV),
    ).resolves.toEqual({
      status: 409,
      error:
        "This member pays for Name of ws_1's plan. They cancel it with Manage your payment in Settings first (it stays active until the end of the period); you can then remove them, and another owner can start their own plan.",
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
