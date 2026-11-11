import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  listCustomerSubscriptions: vi.fn(),
  cancelSubscription: vi.fn(),
  retrieveSubscription: vi.fn(),
  calls: [] as string[],
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: m.findMany } } }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  listCustomerSubscriptions: m.listCustomerSubscriptions,
  cancelSubscription: m.cancelSubscription,
  retrieveSubscription: m.retrieveSubscription,
}));

import { StripeApiError } from "./stripeApi";
import { CANCEL_FAILED_MESSAGE, cancelSubscriptionsBeforeDelete } from "./cancelOnDelete";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
};

beforeEach(() => {
  m.calls = [];
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([{ id: "ws_1", stripeCustomerId: "cus_1" }]);
  m.listCustomerSubscriptions.mockReset();
  m.listCustomerSubscriptions.mockResolvedValue([{ id: "sub_1", status: "active" }]);
  m.cancelSubscription.mockReset();
  m.cancelSubscription.mockImplementation(async (id: string) => {
    m.calls.push(`cancel:${id}`);
    return { id, status: "canceled" };
  });
  m.retrieveSubscription.mockReset();
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("cancelSubscriptionsBeforeDelete", () => {
  it("with payments not configured, reads nothing and calls nothing", async () => {
    const result = await cancelSubscriptionsBeforeDelete(["ws_1"], {}, { ...ENV, BILLING_ENABLED: "" });
    expect(result).toEqual({ ok: true, cancelled: 0 });
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.listCustomerSubscriptions).not.toHaveBeenCalled();
  });

  it("cancels each live subscription of the workspaces' customers", async () => {
    m.listCustomerSubscriptions.mockResolvedValue([
      { id: "sub_1", status: "active" },
      { id: "sub_old", status: "canceled" },
      { id: "sub_2", status: "past_due" },
    ]);
    const result = await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV);
    expect(result).toEqual({ ok: true, cancelled: 2 });
    expect(m.calls).toEqual(["cancel:sub_1", "cancel:sub_2"]);
    expect(m.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["ws_1"] }, stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true },
    });
  });

  it("a workspace without a customer, or with only ended subscriptions, needs nothing", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV)).toEqual({ ok: true, cancelled: 0 });
    m.findMany.mockResolvedValue([{ id: "ws_1", stripeCustomerId: "cus_1" }]);
    m.listCustomerSubscriptions.mockResolvedValue([{ id: "sub_1", status: "canceled" }]);
    expect(await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV)).toEqual({ ok: true, cancelled: 0 });
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("an empty list reads nothing", async () => {
    expect(await cancelSubscriptionsBeforeDelete([], {}, ENV)).toEqual({ ok: true, cancelled: 0 });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("Stripe unreachable while listing: refuses with the sentence, nothing cancelled", async () => {
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    const result = await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV);
    expect(result).toEqual({ ok: false, status: 502, error: CANCEL_FAILED_MESSAGE });
    expect(CANCEL_FAILED_MESSAGE).toBe(
      "We could not cancel your plan, so nothing was deleted. Try again, or cancel it under Settings, Plan first.",
    );
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("Stripe refuses the cancel: refuses", async () => {
    m.cancelSubscription.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
    m.retrieveSubscription.mockResolvedValue({ id: "sub_1", status: "active" });
    expect(await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV)).toEqual({
      ok: false,
      status: 502,
      error: CANCEL_FAILED_MESSAGE,
    });
  });

  it("a cancel that fails because it is already cancelled counts as success", async () => {
    m.cancelSubscription.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
    m.retrieveSubscription.mockResolvedValue({ id: "sub_1", status: "canceled" });
    expect(await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV)).toEqual({ ok: true, cancelled: 1 });
  });

  it("runs the precheck only when something must be cancelled, and before cancelling", async () => {
    const precheck = vi.fn(async () => {
      m.calls.push("precheck");
      return null;
    });
    await cancelSubscriptionsBeforeDelete(["ws_1"], { precheck }, ENV);
    expect(m.calls).toEqual(["precheck", "cancel:sub_1"]);

    precheck.mockClear();
    m.listCustomerSubscriptions.mockResolvedValue([]);
    await cancelSubscriptionsBeforeDelete(["ws_1"], { precheck }, ENV);
    expect(precheck).not.toHaveBeenCalled();
  });

  it("a precheck refusal stops before any cancel", async () => {
    const result = await cancelSubscriptionsBeforeDelete(
      ["ws_1"],
      { precheck: async () => "A post is publishing right now. Try again in a few minutes." },
      ENV,
    );
    expect(result).toEqual({ ok: false, status: 409, error: "A post is publishing right now. Try again in a few minutes." });
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("logs no secret", async () => {
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe answered 401", 401));
    await cancelSubscriptionsBeforeDelete(["ws_1"], {}, ENV);
    expect(JSON.stringify(m.logger.error.mock.calls)).not.toContain("sk_test_example");
  });
});
