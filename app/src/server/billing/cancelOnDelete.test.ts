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
import {
  CANCEL_FAILED_MESSAGE,
  CANCEL_PHASE_BUDGET_MS,
  cancelSubscriptionsBeforeDelete,
  partialCancelMessage,
} from "./cancelOnDelete";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
};

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  stripeCustomerId: `cus_${id}`,
  stripeSubscriptionId: `sub_${id}`,
  plan: "starter",
  ...overrides,
});

/** A clock the test moves forward. */
let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  m.calls = [];
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([row("ws_1")]);
  m.listCustomerSubscriptions.mockReset();
  m.listCustomerSubscriptions.mockImplementation(async (customer: string) => [
    { id: customer.replace("cus_", "sub_"), status: "active" },
  ]);
  m.cancelSubscription.mockReset();
  m.cancelSubscription.mockImplementation(async (id: string) => {
    m.calls.push(`cancel:${id}`);
    return { id, status: "canceled" };
  });
  m.retrieveSubscription.mockReset();
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

const run = (ids: string[], opts: { precheck?: () => Promise<string | null> } = {}, env: Record<string, string | undefined> = ENV) =>
  cancelSubscriptionsBeforeDelete(ids, { ...opts, now }, env);

describe("when it runs (fix round 1: whenever the secret key is set)", () => {
  it("without the secret key, reads nothing and calls nothing", async () => {
    expect(await run(["ws_1"], {}, { ...ENV, STRIPE_SECRET_KEY: "" })).toEqual({ ok: true, cancelled: 0 });
    expect(await run(["ws_1"], {}, {})).toEqual({ ok: true, cancelled: 0 });
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.listCustomerSubscriptions).not.toHaveBeenCalled();
  });

  it("with billing switched off but the key set, still cancels", async () => {
    expect(await run(["ws_1"], {}, { STRIPE_SECRET_KEY: "sk_test_example", BILLING_ENABLED: "" })).toEqual({
      ok: true,
      cancelled: 1,
    });
    expect(m.calls).toEqual(["cancel:sub_ws_1"]);
  });

  it("with billing on and everything configured, cancels", async () => {
    expect(await run(["ws_1"])).toEqual({ ok: true, cancelled: 1 });
  });
});

describe("cancelSubscriptionsBeforeDelete", () => {
  it("cancels each live subscription of the workspaces' customers", async () => {
    m.listCustomerSubscriptions.mockResolvedValue([
      { id: "sub_1", status: "active" },
      { id: "sub_old", status: "canceled" },
      { id: "sub_2", status: "past_due" },
    ]);
    const result = await run(["ws_1"]);
    expect(result).toEqual({ ok: true, cancelled: 2 });
    expect(m.calls).toEqual(["cancel:sub_1", "cancel:sub_2"]);
    expect(m.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["ws_1"] }, stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true, stripeSubscriptionId: true, plan: true },
    });
  });

  it("a workspace without a customer, or with only ended subscriptions, needs nothing", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await run(["ws_1"])).toEqual({ ok: true, cancelled: 0 });
    m.findMany.mockResolvedValue([row("ws_1")]);
    m.listCustomerSubscriptions.mockResolvedValue([{ id: "sub_1", status: "canceled" }]);
    expect(await run(["ws_1"])).toEqual({ ok: true, cancelled: 0 });
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("an empty list reads nothing", async () => {
    expect(await run([])).toEqual({ ok: true, cancelled: 0 });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("Stripe unreachable while listing, for a workspace with a plan: refuses, nothing cancelled", async () => {
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    expect(await run(["ws_1"])).toEqual({ ok: false, status: 502, error: CANCEL_FAILED_MESSAGE });
    expect(CANCEL_FAILED_MESSAGE).toBe(
      "We could not cancel your plan, so nothing was deleted. Try again, or cancel it under Settings, Plan first.",
    );
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("Stripe unreachable while listing, for a workspace with only a stored subscription id: refuses", async () => {
    m.findMany.mockResolvedValue([row("ws_1", { plan: null })]);
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe answered 503", 503));
    expect(await run(["ws_1"])).toMatchObject({ ok: false, error: CANCEL_FAILED_MESSAGE });
  });

  it("Stripe unreachable while listing, for a customer who never subscribed: goes on and deletes", async () => {
    m.findMany.mockResolvedValue([row("ws_1", { plan: null, stripeSubscriptionId: null })]);
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe answered 503", 503));
    expect(await run(["ws_1"])).toEqual({ ok: true, cancelled: 0 });
  });

  it("Stripe refuses the cancel: refuses", async () => {
    m.cancelSubscription.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
    m.retrieveSubscription.mockResolvedValue({ id: "sub_ws_1", status: "active" });
    expect(await run(["ws_1"])).toEqual({ ok: false, status: 502, error: CANCEL_FAILED_MESSAGE });
  });

  it("a cancel that fails because it is already cancelled counts as success", async () => {
    m.cancelSubscription.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
    m.retrieveSubscription.mockResolvedValue({ id: "sub_ws_1", status: "canceled" });
    expect(await run(["ws_1"])).toEqual({ ok: true, cancelled: 1 });
  });

  it("runs the precheck only when something must be cancelled, and before cancelling", async () => {
    const precheck = vi.fn(async () => {
      m.calls.push("precheck");
      return null;
    });
    await run(["ws_1"], { precheck });
    expect(m.calls).toEqual(["precheck", "cancel:sub_ws_1"]);

    precheck.mockClear();
    m.listCustomerSubscriptions.mockResolvedValue([]);
    await run(["ws_1"], { precheck });
    expect(precheck).not.toHaveBeenCalled();
  });

  it("a precheck refusal stops before any cancel", async () => {
    const result = await run(["ws_1"], {
      precheck: async () => "A post is publishing right now. Try again in a few minutes.",
    });
    expect(result).toEqual({ ok: false, status: 409, error: "A post is publishing right now. Try again in a few minutes." });
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("logs no secret", async () => {
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe answered 401", 401));
    await run(["ws_1"]);
    expect(JSON.stringify(m.logger.error.mock.calls)).not.toContain("sk_test_example");
  });
});

describe("the 20-second bound and partial cancels (fix round 1)", () => {
  beforeEach(() => {
    m.findMany.mockResolvedValue([row("ws_1"), row("ws_2"), row("ws_3")]);
  });

  it("the bound is 20 seconds, and every call gets at most what is left", async () => {
    expect(CANCEL_PHASE_BUDGET_MS).toBe(20_000);
    m.listCustomerSubscriptions.mockImplementation(async (customer: string, _env: unknown, timeoutMs: number) => {
      m.calls.push(`list:${timeoutMs}`);
      clock += 4_000;
      return [{ id: customer.replace("cus_", "sub_"), status: "active" }];
    });
    m.cancelSubscription.mockImplementation(async (id: string, _env: unknown, timeoutMs: number) => {
      m.calls.push(`cancel:${id}:${timeoutMs}`);
      clock += 2_000;
      return { id, status: "canceled" };
    });
    expect(await run(["ws_1", "ws_2", "ws_3"])).toEqual({ ok: true, cancelled: 3 });
    // 12 s spent listing; the cancels get min(10 s, what is left).
    expect(m.calls).toEqual(["list:10000", "list:10000", "list:10000", "cancel:sub_ws_1:8000", "cancel:sub_ws_2:6000", "cancel:sub_ws_3:4000"]);
  });

  it("running out of time after some cancels deletes nothing and says how many were cancelled", async () => {
    m.cancelSubscription.mockImplementation(async (id: string) => {
      m.calls.push(`cancel:${id}`);
      clock += 15_000;
      return { id, status: "canceled" };
    });
    const result = await run(["ws_1", "ws_2", "ws_3"]);
    expect(result).toEqual({ ok: false, status: 502, error: "2 of your plans were cancelled, but we could not finish. Nothing was deleted. Try again." });
    expect(partialCancelMessage(2)).toBe("2 of your plans were cancelled, but we could not finish. Nothing was deleted. Try again.");
    expect(partialCancelMessage(1)).toBe("1 of your plans was cancelled, but we could not finish. Nothing was deleted. Try again.");
  });

  it("a cancel that fails after others succeeded deletes nothing and says how many", async () => {
    m.cancelSubscription
      .mockImplementationOnce(async (id: string) => ({ id, status: "canceled" }))
      .mockRejectedValueOnce(new StripeApiError("Stripe answered 500", 500));
    m.retrieveSubscription.mockResolvedValue({ id: "sub_ws_2", status: "active" });
    expect(await run(["ws_1", "ws_2", "ws_3"])).toEqual({ ok: false, status: 502, error: partialCancelMessage(1) });
  });

  it("running out of time while listing refuses with the plain sentence", async () => {
    m.listCustomerSubscriptions.mockImplementation(async (customer: string) => {
      clock += 21_000;
      return [{ id: customer.replace("cus_", "sub_"), status: "active" }];
    });
    expect(await run(["ws_1", "ws_2", "ws_3"])).toEqual({ ok: false, status: 502, error: CANCEL_FAILED_MESSAGE });
    expect(m.cancelSubscription).not.toHaveBeenCalled();
  });

  it("a retry skips the plans already cancelled", async () => {
    m.listCustomerSubscriptions.mockImplementation(async (customer: string) => [
      { id: customer.replace("cus_", "sub_"), status: customer === "cus_ws_3" ? "active" : "canceled" },
    ]);
    expect(await run(["ws_1", "ws_2", "ws_3"])).toEqual({ ok: true, cancelled: 1 });
    expect(m.calls).toEqual(["cancel:sub_ws_3"]);
  });
});
