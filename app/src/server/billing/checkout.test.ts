import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  billingExempt: boolean;
  plan: string | null;
  planStatus: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

const m = vi.hoisted(() => ({
  row: null as Row | null,
  writes: [] as unknown[],
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  listCustomerSubscriptions: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  createCustomer: m.createCustomer,
  createCheckoutSession: m.createCheckoutSession,
  createPortalSession: m.createPortalSession,
  listCustomerSubscriptions: m.listCustomerSubscriptions,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUnique: async () => (m.row ? { ...m.row } : null),
      updateMany: async ({ where, data }: { where: { stripeCustomerId: null }; data: Partial<Row> }) => {
        m.writes.push({ where, data });
        if (!m.row || m.row.stripeCustomerId !== where.stripeCustomerId) return { count: 0 };
        m.row = { ...m.row, ...data };
        return { count: 1 };
      },
    },
  },
}));

import { StripeApiError } from "./stripeApi";
import { CHECKOUT_MESSAGES, openPortal, startCheckout } from "./checkout";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
};
const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const BASE = "https://app.example";

const input = (plan: "starter" | "growth" | "pro" = "starter") => ({
  workspaceId: "ws_1",
  ownerEmail: "owner@example.com",
  plan,
  now: NOW,
  baseUrl: BASE,
});

function trialRow(overrides: Partial<Row> = {}): Row {
  return {
    billingExempt: false,
    plan: null,
    planStatus: null,
    trialEndsAt: new Date(NOW.getTime() + 10 * DAY),
    currentPeriodEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  m.row = trialRow();
  m.writes = [];
  m.createCustomer.mockReset();
  m.createCustomer.mockResolvedValue({ id: "cus_1" });
  m.createCheckoutSession.mockReset();
  m.createCheckoutSession.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  m.createPortalSession.mockReset();
  m.createPortalSession.mockResolvedValue({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" });
  m.listCustomerSubscriptions.mockReset();
  m.listCustomerSubscriptions.mockResolvedValue([]);
  for (const fn of Object.values(m.logger)) fn.mockReset();
});

describe("startCheckout", () => {
  it("creates the customer, saves it, then a subscription session with the reference, metadata and trial end", async () => {
    const result = await startCheckout(input(), ENV);
    expect(result).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });

    expect(m.createCustomer).toHaveBeenCalledWith(
      { workspaceId: "ws_1", email: "owner@example.com" },
      "vs-customer-ws_1",
      ENV,
    );
    expect(m.writes).toEqual([{ where: { id: "ws_1", stripeCustomerId: null }, data: { stripeCustomerId: "cus_1" } }]);

    const [session, key] = m.createCheckoutSession.mock.calls[0];
    expect(session).toEqual({
      customer: "cus_1",
      priceId: "price_example_starter",
      workspaceId: "ws_1",
      trialEnd: Math.floor((NOW.getTime() + 10 * DAY) / 1000),
      successUrl: "https://app.example/settings?billing=success#plan",
      cancelUrl: "https://app.example/settings#plan",
    });
    expect(key).toMatch(/^vs-checkout-ws_1-starter-\d+$/);
  });

  it("writes nothing to the plan columns", async () => {
    await startCheckout(input(), ENV);
    for (const write of m.writes as Array<{ data: Record<string, unknown> }>) {
      expect(Object.keys(write.data)).toEqual(["stripeCustomerId"]);
    }
  });

  it("a second click uses the saved customer and the same idempotency key", async () => {
    await startCheckout(input(), ENV);
    await startCheckout(input(), ENV);
    expect(m.createCustomer).toHaveBeenCalledTimes(1);
    expect(m.listCustomerSubscriptions).toHaveBeenCalledWith("cus_1", ENV);
    expect(m.createCheckoutSession.mock.calls[0][1]).toBe(m.createCheckoutSession.mock.calls[1][1]);
  });

  it("when another request saved a customer first, uses that one", async () => {
    m.createCustomer.mockImplementation(async () => {
      m.row = { ...m.row!, stripeCustomerId: "cus_first" };
      return { id: "cus_1" };
    });
    await startCheckout(input(), ENV);
    expect(m.createCheckoutSession.mock.calls[0][0].customer).toBe("cus_first");
  });

  it("leaves the trial out when it ends in less than 48 hours (and a margin)", async () => {
    m.row = trialRow({ trialEndsAt: new Date(NOW.getTime() + 2 * DAY) });
    await startCheckout(input(), ENV);
    expect(m.createCheckoutSession.mock.calls[0][0].trialEnd).toBeNull();

    m.row = trialRow({ trialEndsAt: new Date(NOW.getTime() + 2 * DAY + 2 * 60 * 60 * 1000) });
    await startCheckout(input(), ENV);
    expect(m.createCheckoutSession.mock.calls[1][0].trialEnd).not.toBeNull();
  });

  it("an ended trial passes no trial end", async () => {
    m.row = trialRow({ trialEndsAt: new Date(NOW.getTime() - DAY) });
    await startCheckout(input(), ENV);
    expect(m.createCheckoutSession.mock.calls[0][0].trialEnd).toBeNull();
  });

  it("refuses a plan with no price, before any call", async () => {
    expect(await startCheckout(input("pro"), ENV)).toEqual({ ok: false, status: 400, error: CHECKOUT_MESSAGES.notOffered });
    expect(m.createCustomer).not.toHaveBeenCalled();
  });

  it("refuses a workspace exempt by its flag", async () => {
    m.row = trialRow({ billingExempt: true });
    expect(await startCheckout(input(), ENV)).toEqual({ ok: false, status: 409, error: "This workspace is billed by invoice." });
    expect(m.createCustomer).not.toHaveBeenCalled();
  });

  it("lets a workspace exempt only by having no plan and no trial buy a plan, without a trial", async () => {
    m.row = trialRow({ trialEndsAt: null });
    const result = await startCheckout(input(), ENV);
    expect(result.ok).toBe(true);
    expect(m.createCheckoutSession.mock.calls[0][0].trialEnd).toBeNull();
  });

  it("refuses a workspace whose stored subscription is live", async () => {
    for (const planStatus of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
      m.row = trialRow({ plan: "starter", planStatus, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
      expect(await startCheckout(input(), ENV), planStatus).toEqual({
        ok: false,
        status: 409,
        error: "Use Manage plan to change it.",
      });
    }
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses when Stripe has a live subscription the webhook has not written yet", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    m.listCustomerSubscriptions.mockResolvedValue([{ id: "sub_1", status: "active" }]);
    expect(await startCheckout(input(), ENV)).toMatchObject({ ok: false, status: 409 });
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("lets a workspace whose plan was canceled choose again", async () => {
    m.row = trialRow({ plan: "starter", planStatus: "canceled", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
    m.listCustomerSubscriptions.mockResolvedValue([{ id: "sub_1", status: "canceled" }]);
    expect((await startCheckout(input("growth"), ENV)).ok).toBe(true);
  });

  it("a Stripe failure answers 502 with a plain sentence and logs no secret", async () => {
    m.createCheckoutSession.mockRejectedValue(new StripeApiError("Stripe answered 500", 500));
    const result = await startCheckout(input(), ENV);
    expect(result).toEqual({ ok: false, status: 502, error: CHECKOUT_MESSAGES.stripeDown });
    expect(JSON.stringify(m.logger.error.mock.calls)).not.toContain("sk_test_example");
  });

  it("a missing workspace answers 404", async () => {
    m.row = null;
    expect(await startCheckout(input(), ENV)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("openPortal", () => {
  it("returns the portal address for the workspace's customer", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    const result = await openPortal({ workspaceId: "ws_1", now: NOW, baseUrl: BASE }, ENV);
    expect(result).toEqual({ ok: true, url: "https://billing.stripe.com/p/session/x" });
    const [args, key] = m.createPortalSession.mock.calls[0];
    expect(args).toEqual({ customer: "cus_1", returnUrl: "https://app.example/settings#plan" });
    expect(key).toMatch(/^vs-portal-ws_1-\d+$/);
  });

  it("refuses when the workspace has no customer", async () => {
    expect(await openPortal({ workspaceId: "ws_1", now: NOW, baseUrl: BASE }, ENV)).toEqual({
      ok: false,
      status: 409,
      error: CHECKOUT_MESSAGES.noCustomer,
    });
    expect(m.createPortalSession).not.toHaveBeenCalled();
  });

  it("a Stripe failure answers 502", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    m.createPortalSession.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    expect(await openPortal({ workspaceId: "ws_1", now: NOW, baseUrl: BASE }, ENV)).toMatchObject({ ok: false, status: 502 });
  });
});
