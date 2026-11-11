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
  listCheckoutSessions: vi.fn(),
  expireCheckoutSession: vi.fn(),
  order: [] as string[],
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  createCustomer: m.createCustomer,
  createCheckoutSession: m.createCheckoutSession,
  createPortalSession: m.createPortalSession,
  listCustomerSubscriptions: m.listCustomerSubscriptions,
  listCheckoutSessions: m.listCheckoutSessions,
  expireCheckoutSession: m.expireCheckoutSession,
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
  m.order = [];
  m.listCheckoutSessions.mockReset();
  m.listCheckoutSessions.mockResolvedValue([]);
  m.expireCheckoutSession.mockReset();
  m.expireCheckoutSession.mockImplementation(async (id: string) => {
    m.order.push(`expire:${id}`);
    return { id, status: "expired" };
  });
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
    expect(key).toMatch(/^vs-checkout-ws_1-starter-n0-[0-9a-f]{16}-\d+$/);
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

/** Fix round 1: an abandoned Checkout page paid later, or two tabs, would make a second subscription. */
describe("open Checkout sessions are expired first", () => {
  beforeEach(() => {
    m.createCheckoutSession.mockImplementation(async () => {
      m.order.push("create");
      return { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" };
    });
  });

  it("expires each of the customer's open sessions, then creates the new one", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    m.listCheckoutSessions.mockResolvedValue([
      { id: "cs_a", status: "open" },
      { id: "cs_b", status: "open" },
    ]);
    expect((await startCheckout(input(), ENV)).ok).toBe(true);
    expect(m.listCheckoutSessions).toHaveBeenCalledWith("cus_1", ENV);
    expect(m.order).toEqual(["expire:cs_a", "expire:cs_b", "create"]);
    expect(m.expireCheckoutSession).toHaveBeenCalledWith("cs_a", "vs-expire-cs_a", ENV);
  });

  it("checks a new customer too", async () => {
    await startCheckout(input(), ENV);
    expect(m.listCheckoutSessions).toHaveBeenCalledWith("cus_1", ENV);
  });

  it("a second click expires the first page and gets a new one, not the expired one back", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    await startCheckout(input(), ENV);
    m.listCheckoutSessions.mockResolvedValue([{ id: "cs_new", status: "open" }]);
    await startCheckout(input(), ENV);
    const [first, second] = m.createCheckoutSession.mock.calls.map((call) => call[1]);
    expect(first).not.toBe(second);
  });

  it("two clicks that both find nothing open share one key, so Stripe makes one session", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    await startCheckout(input(), ENV);
    await startCheckout(input(), ENV);
    const [first, second] = m.createCheckoutSession.mock.calls.map((call) => call[1]);
    expect(first).toBe(second);
  });

  it("an expire Stripe refuses stops before a new session is made", async () => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    m.listCheckoutSessions.mockResolvedValue([{ id: "cs_a", status: "open" }]);
    m.expireCheckoutSession.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
    expect(await startCheckout(input(), ENV)).toMatchObject({ ok: false, status: 502 });
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });
});

/**
 * Fix round 2: Stripe replays a saved answer for a repeated idempotency key,
 * so the key must change whenever the sessions Stripe holds have changed.
 * This fake keeps the customer's sessions and Stripe's idempotency store.
 */
describe("idempotency keys never replay an expired session", () => {
  let sessions: Array<{ id: string; status: string }>;
  let saved: Map<string, { id: string; url: string }>;
  let failNextCreate: boolean;

  beforeEach(() => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    sessions = [];
    saved = new Map();
    failNextCreate = false;
    m.listCheckoutSessions.mockImplementation(async () => sessions.map((s) => ({ ...s })));
    m.expireCheckoutSession.mockImplementation(async (id: string) => {
      const session = sessions.find((s) => s.id === id)!;
      session.status = "expired";
      return { ...session };
    });
    m.createCheckoutSession.mockImplementation(async (_args: unknown, key: string) => {
      const replay = saved.get(key);
      if (replay) return replay;
      if (failNextCreate) {
        failNextCreate = false;
        throw new StripeApiError("Stripe answered 500", 500);
      }
      const id = `cs_${sessions.length + 1}`;
      sessions.unshift({ id, status: "open" });
      const answer = { id, url: `https://checkout.stripe.com/c/pay/${id}` };
      saved.set(key, answer);
      return answer;
    });
  });

  const statusOf = (url: string) => sessions.find((s) => url.endsWith(s.id))?.status;

  it("click, then click again with the first still open: the first is expired and the second is new", async () => {
    const first = await startCheckout(input(), ENV);
    const second = await startCheckout(input(), ENV);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.url).not.toBe(first.url);
    expect(statusOf(first.url)).toBe("expired");
    expect(statusOf(second.url)).toBe("open");
    const [k1, k2] = m.createCheckoutSession.mock.calls.map((call) => call[1]);
    expect(k1).not.toBe(k2);
  });

  it("click; click that expires it and whose create fails; click: ends on a live session", async () => {
    await startCheckout(input(), ENV);
    failNextCreate = true;
    expect((await startCheckout(input(), ENV)).ok).toBe(false);
    const third = await startCheckout(input(), ENV);
    expect(third.ok).toBe(true);
    if (third.ok) expect(statusOf(third.url)).toBe("open");
  });

  it("a plain double click within a second creates one session", async () => {
    // Both requests list before either creates.
    const [a, b] = await Promise.all([startCheckout(input(), ENV), startCheckout(input(), ENV)]);
    expect(a.ok && b.ok && a.url === b.url).toBe(true);
    expect(sessions).toHaveLength(1);
  });
});

/** Fix round 2: a session paid a moment ago cannot be expired; that is not a Stripe outage. */
describe("an expire that fails because the session was just paid", () => {
  beforeEach(() => {
    m.row = trialRow({ stripeCustomerId: "cus_1" });
    m.listCheckoutSessions.mockResolvedValue([{ id: "cs_a", status: "open" }]);
    m.expireCheckoutSession.mockRejectedValue(new StripeApiError("Stripe answered 400", 400));
  });

  it("checks the subscriptions again; with one live, says the plan is on its way", async () => {
    m.listCustomerSubscriptions.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "sub_1", status: "active" }]);
    expect(await startCheckout(input(), ENV)).toEqual({
      ok: false,
      status: 409,
      error: "You already have a plan. It appears here within a minute.",
    });
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("with none live, it is the plain Stripe sentence", async () => {
    expect(await startCheckout(input(), ENV)).toEqual({ ok: false, status: 502, error: CHECKOUT_MESSAGES.stripeDown });
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
