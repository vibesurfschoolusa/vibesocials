import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  retrieveCustomer: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: m.findMany } } }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  retrieveCustomer: m.retrieveCustomer,
}));

import { StripeApiError } from "./stripeApi";
import { PAYER_CHECK_FAILED_MESSAGE, payerRefusal } from "./payerRefusal";

/**
 * R5-security L2: leaving a workspace, or deleting the account, must not leave
 * the person's card paying for a workspace that carries on without them.
 */

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
};

const running = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Name of ${id}`,
  stripeCustomerId: `cus_${id}`,
  planStatus: "active",
  ...overrides,
});

beforeEach(() => {
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([running("ws_1")]);
  m.retrieveCustomer.mockReset();
  m.retrieveCustomer.mockResolvedValue({ id: "cus_ws_1", email: "someone.else@example.com" });
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("payerRefusal", () => {
  it("refuses the person whose email the plan's Stripe customer carries, naming the workspace", async () => {
    m.retrieveCustomer.mockResolvedValue({ id: "cus_ws_1", email: "Payer@Example.com " });

    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, ENV)).resolves.toEqual({
      status: 409,
      error: 'You pay for the plan of "Name of ws_1", which carries on after you go. Hand over or cancel the plan under Settings, Plan first.',
    });
    expect(m.retrieveCustomer).toHaveBeenCalledWith("cus_ws_1", ENV);
  });

  it("reads only running plans not set to end, of the workspaces that survive", async () => {
    await payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1", "ws_2"] }, ENV);
    expect(m.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["ws_1", "ws_2"] },
        stripeCustomerId: { not: null },
        stripeSubscriptionId: { not: null },
        planEndsAt: null,
      },
      select: { id: true, name: true, stripeCustomerId: true, planStatus: true },
    });
  });

  it("lets someone else leave", async () => {
    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
  });

  it("asks Stripe nothing for a plan that is no longer live", async () => {
    m.findMany.mockResolvedValue([running("ws_1", { planStatus: "canceled" })]);
    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
    expect(m.retrieveCustomer).not.toHaveBeenCalled();
  });

  it("a customer deleted at Stripe, or with no email, pays nothing for this person", async () => {
    m.retrieveCustomer.mockResolvedValue({ id: "cus_ws_1", deleted: true });
    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, ENV)).resolves.toBeNull();
  });

  it("answers 502 and changes nothing when Stripe cannot be asked", async () => {
    m.retrieveCustomer.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, ENV)).resolves.toEqual({
      status: 502,
      error: PAYER_CHECK_FAILED_MESSAGE,
    });
    expect(PAYER_CHECK_FAILED_MESSAGE).toBe(
      "We could not check who pays for a plan you are part of, so nothing was changed. Try again in a minute.",
    );
    expect(m.logger.error).toHaveBeenCalled();
  });

  it("does nothing with billing off, without the Stripe key, or with no workspace", async () => {
    await expect(
      payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, { ...ENV, BILLING_ENABLED: "" }),
    ).resolves.toBeNull();
    await expect(
      payerRefusal({ email: "payer@example.com", workspaceIds: ["ws_1"] }, { ...ENV, STRIPE_SECRET_KEY: "" }),
    ).resolves.toBeNull();
    await expect(payerRefusal({ email: "payer@example.com", workspaceIds: [] }, ENV)).resolves.toBeNull();
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
