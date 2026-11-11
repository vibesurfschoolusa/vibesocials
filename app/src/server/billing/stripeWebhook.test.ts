import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook's handling of a verified event, against an in-memory database
 * whose $transaction rolls back on a throw. Stripe is reached only through
 * the mocked retrieveSubscription; email only through the mocked sendEmail.
 */
type Row = {
  id: string;
  name: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingExempt: boolean;
  plan: string | null;
  planStatus: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  planEndsAt?: Date | null;
  stripeLastEventAt?: Date | null;
};

const m = vi.hoisted(() => ({
  events: new Map<string, string>(),
  workspaces: new Map<string, Row>(),
  owners: new Map<string, Array<{ userId: string; email: string }>>(),
  retrieveSubscription: vi.fn(),
  listCustomerSubscriptions: vi.fn(),
  sendEmail: vi.fn(),
  failNextUpdate: false,
  collideNextUpdate: false,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/server/notifications/email", () => ({
  sendEmail: m.sendEmail,
  isRetryableEmailError: () => true,
}));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  retrieveSubscription: m.retrieveSubscription,
  listCustomerSubscriptions: m.listCustomerSubscriptions,
}));
vi.mock("@/lib/db", () => {
  function client(events: Map<string, string>, workspaces: Map<string, Row>) {
    return {
      stripeEvent: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          events.has(where.id) ? { id: where.id, type: events.get(where.id) } : null,
        createMany: async ({ data }: { data: Array<{ id: string; type: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (!events.has(row.id)) {
              events.set(row.id, row.type);
              count++;
            }
          }
          return { count };
        },
      },
      workspace: {
        findUnique: async ({ where }: { where: { id?: string; stripeCustomerId?: string } }) => {
          const row = where.id
            ? workspaces.get(where.id)
            : [...workspaces.values()].find((w) => w.stripeCustomerId === where.stripeCustomerId);
          if (!row) return null;
          return { ...row, members: (m.owners.get(row.id) ?? []).map((o) => ({ userId: o.userId, user: { email: o.email } })) };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          if (m.failNextUpdate) {
            m.failNextUpdate = false;
            throw new Error("database unavailable");
          }
          if (m.collideNextUpdate) {
            m.collideNextUpdate = false;
            throw Object.assign(new Error("Unique constraint failed on the fields: (stripeSubscriptionId)"), {
              code: "P2002",
              meta: { modelName: "Workspace", target: ["stripeSubscriptionId"] },
            });
          }
          const row = workspaces.get(where.id)!;
          workspaces.set(where.id, { ...row, ...data });
          return workspaces.get(where.id);
        },
      },
    };
  }
  const prisma = {
    ...client(m.events, m.workspaces),
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // Work on copies; publish them only when the callback returns.
      const events = new Map(m.events);
      const workspaces = new Map([...m.workspaces].map(([k, v]) => [k, { ...v }]));
      const result = await cb(client(events, workspaces));
      m.events.clear();
      for (const [k, v] of events) m.events.set(k, v);
      m.workspaces.clear();
      for (const [k, v] of workspaces) m.workspaces.set(k, v);
      return result;
    },
  };
  return { prisma };
});

import { StripeApiError, type StripeSubscription } from "./stripeApi";
import { handleStripeEvent } from "./stripeWebhook";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

const PERIOD_END = 1800000000;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_a",
    metadata: { workspaceId: "ws_a" },
    trial_end: null,
    items: { data: [{ price: { id: "price_example_starter" }, current_period_end: PERIOD_END }] },
    ...overrides,
  };
}

function subscriptionEvent(id: string, type: string, payload: Partial<StripeSubscription> = {}, created?: number) {
  // The payload deliberately disagrees with Stripe's answer: it must not be read.
  return {
    id,
    type,
    ...(created === undefined ? {} : { created }),
    data: { object: { id: "sub_1", object: "subscription", status: "incomplete", ...payload } },
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "ws_a",
    name: "Surf A",
    stripeCustomerId: "cus_a",
    stripeSubscriptionId: null,
    billingExempt: false,
    plan: null,
    planStatus: null,
    trialEndsAt: new Date("2026-11-20T00:00:00Z"),
    currentPeriodEnd: null,
    ...overrides,
  };
}

const ws = (id = "ws_a") => m.workspaces.get(id)!;

beforeEach(() => {
  m.events.clear();
  m.workspaces.clear();
  m.owners.clear();
  m.failNextUpdate = false;
  m.collideNextUpdate = false;
  m.listCustomerSubscriptions.mockReset();
  // Unless a test says otherwise, the customer holds exactly the subscription last fetched.
  m.listCustomerSubscriptions.mockImplementation(async () => {
    const last = m.retrieveSubscription.mock.results.at(-1);
    return last ? [await last.value] : [];
  });
  m.retrieveSubscription.mockReset();
  m.sendEmail.mockReset();
  m.sendEmail.mockResolvedValue(undefined);
  for (const fn of Object.values(m.logger)) fn.mockReset();
  m.workspaces.set("ws_a", row());
  m.workspaces.set("ws_b", row({ id: "ws_b", name: "Surf B", stripeCustomerId: "cus_b" }));
});

describe("subscription events", () => {
  it("a purchase writes the plan, status, period end and subscription id from the fetched subscription", async () => {
    m.retrieveSubscription.mockResolvedValue(sub());
    const status = await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    expect(status).toBe(200);
    expect(m.retrieveSubscription).toHaveBeenCalledWith("sub_1", ENV);
    expect(ws()).toMatchObject({
      plan: "starter",
      planStatus: "active",
      currentPeriodEnd: new Date(PERIOD_END * 1000),
      stripeSubscriptionId: "sub_1",
    });
    expect(m.events.get("evt_1")).toBe("customer.subscription.created");
  });

  it("checkout.session.completed fetches the session's subscription", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ id: "sub_9" }));
    const status = await handleStripeEvent(
      {
        id: "evt_c",
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", mode: "subscription", subscription: "sub_9", client_reference_id: "ws_a", customer: "cus_a" } },
      },
      ENV,
    );
    expect(status).toBe(200);
    expect(m.retrieveSubscription).toHaveBeenCalledWith("sub_9", ENV);
    expect(ws().stripeSubscriptionId).toBe("sub_9");
  });

  it("checkout.session.completed binds the customer of a workspace that has none, when the session names it", async () => {
    m.workspaces.set("ws_a", row({ stripeCustomerId: null }));
    m.retrieveSubscription.mockResolvedValue(sub());
    await handleStripeEvent(
      {
        id: "evt_c",
        type: "checkout.session.completed",
        data: { object: { id: "cs_2", mode: "subscription", subscription: "sub_1", client_reference_id: "ws_a", customer: "cus_a" } },
      },
      ENV,
    );
    expect(ws()).toMatchObject({ stripeCustomerId: "cus_a", plan: "starter" });
  });

  it("a payment-mode checkout session is recorded and ignored", async () => {
    const status = await handleStripeEvent(
      { id: "evt_p", type: "checkout.session.completed", data: { object: { id: "cs_p", mode: "payment", subscription: null } } },
      ENV,
    );
    expect(status).toBe(200);
    expect(m.retrieveSubscription).not.toHaveBeenCalled();
    expect(m.events.has("evt_p")).toBe(true);
  });

  it("an event handled twice changes nothing the second time", async () => {
    m.retrieveSubscription.mockResolvedValue(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV);
    // Someone changes the row in between; a replay must not write it back.
    m.workspaces.set("ws_a", { ...ws(), planStatus: "past_due" });
    m.retrieveSubscription.mockClear();
    const status = await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV);
    expect(status).toBe(200);
    expect(ws().planStatus).toBe("past_due");
    expect(m.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("out of order: an older event arriving last still writes what Stripe says now", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ status: "canceled" }));
    await handleStripeEvent(subscriptionEvent("evt_new", "customer.subscription.deleted"), ENV);
    // The older 'created' event arrives later; Stripe still says canceled.
    await handleStripeEvent(subscriptionEvent("evt_old", "customer.subscription.created", { status: "active" }), ENV);
    expect(ws().planStatus).toBe("canceled");
  });

  it("a renewal moves the period end; a failed payment sets past_due; a plan change sets the new plan", async () => {
    m.retrieveSubscription.mockResolvedValueOnce(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);

    m.retrieveSubscription.mockResolvedValueOnce(
      sub({ items: { data: [{ price: { id: "price_example_starter" }, current_period_end: PERIOD_END + 2592000 }] } }),
    );
    await handleStripeEvent(subscriptionEvent("evt_2", "customer.subscription.updated"), ENV);
    expect(ws().currentPeriodEnd).toEqual(new Date((PERIOD_END + 2592000) * 1000));

    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "past_due" }));
    await handleStripeEvent(subscriptionEvent("evt_3", "customer.subscription.updated"), ENV);
    expect(ws().planStatus).toBe("past_due");

    m.retrieveSubscription.mockResolvedValueOnce(
      sub({ items: { data: [{ price: { id: "price_example_pro" }, current_period_end: PERIOD_END }] } }),
    );
    await handleStripeEvent(subscriptionEvent("evt_4", "customer.subscription.updated"), ENV);
    expect(ws()).toMatchObject({ plan: "pro", planStatus: "active" });
  });

  it("a cancellation sets canceled and keeps the plan", async () => {
    m.workspaces.set("ws_a", row({ plan: "growth", planStatus: "active", stripeSubscriptionId: "sub_1" }));
    m.retrieveSubscription.mockResolvedValue(
      sub({ status: "canceled", items: { data: [{ price: { id: "price_example_growth" }, current_period_end: PERIOD_END }] } }),
    );
    await handleStripeEvent(subscriptionEvent("evt_d", "customer.subscription.deleted"), ENV);
    expect(ws()).toMatchObject({ plan: "growth", planStatus: "canceled" });
  });

  it("writes the trial end when the subscription has one", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ status: "trialing", trial_end: 1799000000 }));
    await handleStripeEvent(subscriptionEvent("evt_t", "customer.subscription.created"), ENV);
    expect(ws()).toMatchObject({ planStatus: "trialing", trialEndsAt: new Date(1799000000 * 1000) });
  });

  it("metadata naming workspace A with B's customer changes nothing, is logged with the event id, and is recorded", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ customer: "cus_b" }));
    const before = { ...ws("ws_a") };
    const beforeB = { ...ws("ws_b") };
    const status = await handleStripeEvent(subscriptionEvent("evt_x", "customer.subscription.created"), ENV);
    expect(status).toBe(200);
    expect(ws("ws_a")).toEqual(before);
    expect(ws("ws_b")).toEqual(beforeB);
    expect(m.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: "evt_x" }));
  });

  it("an unknown price changes nothing and is logged", async () => {
    m.retrieveSubscription.mockResolvedValue(
      sub({ items: { data: [{ price: { id: "price_example_other" }, current_period_end: PERIOD_END }] } }),
    );
    const before = { ...ws() };
    await handleStripeEvent(subscriptionEvent("evt_u", "customer.subscription.created"), ENV);
    expect(ws()).toEqual(before);
    expect(m.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: "evt_u" }));
  });

  it("a subscription naming no workspace changes nothing", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ metadata: {} }));
    const before = { ...ws() };
    expect(await handleStripeEvent(subscriptionEvent("evt_n", "customer.subscription.created"), ENV)).toBe(200);
    expect(ws()).toEqual(before);
  });

  it("a failed fetch answers 500 and records nothing", async () => {
    m.retrieveSubscription.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    const status = await handleStripeEvent(subscriptionEvent("evt_f", "customer.subscription.updated"), ENV);
    expect(status).toBe(500);
    expect(m.events.has("evt_f")).toBe(false);
  });

  it("a failed write answers 500 and records nothing", async () => {
    m.retrieveSubscription.mockResolvedValue(sub());
    m.failNextUpdate = true;
    const status = await handleStripeEvent(subscriptionEvent("evt_w", "customer.subscription.updated"), ENV);
    expect(status).toBe(500);
    expect(m.events.has("evt_w")).toBe(false);
    expect(ws().plan).toBeNull();
  });

  it("an exempt-flag workspace gets the subscription written and an error logged for the operator", async () => {
    m.workspaces.set("ws_a", row({ billingExempt: true }));
    m.retrieveSubscription.mockResolvedValue(sub());
    await handleStripeEvent(subscriptionEvent("evt_e", "customer.subscription.created"), ENV);
    expect(ws().plan).toBe("starter");
    expect(m.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: "evt_e", workspaceId: "ws_a" }));
  });
});

/** Fix round 1, item 8: deliveries that commit out of order. */
describe("event order", () => {
  const T = 1799000000;

  it("newer then older: the older changes nothing and is recorded as handled", async () => {
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "past_due" }));
    await handleStripeEvent(subscriptionEvent("evt_new", "customer.subscription.updated", {}, T + 10), ENV);
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "active" }));
    expect(await handleStripeEvent(subscriptionEvent("evt_old", "customer.subscription.updated", {}, T), ENV)).toBe(200);
    expect(ws()).toMatchObject({ planStatus: "past_due", stripeLastEventAt: new Date((T + 10) * 1000) });
    expect(m.events.has("evt_old")).toBe(true);
  });

  it("older then newer: both write, the newer last", async () => {
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "active" }));
    await handleStripeEvent(subscriptionEvent("evt_old", "customer.subscription.updated", {}, T), ENV);
    expect(ws().stripeLastEventAt).toEqual(new Date(T * 1000));
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "past_due" }));
    await handleStripeEvent(subscriptionEvent("evt_new", "customer.subscription.updated", {}, T + 10), ENV);
    expect(ws()).toMatchObject({ planStatus: "past_due", stripeLastEventAt: new Date((T + 10) * 1000) });
  });

  it("the same time twice: the second still writes", async () => {
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "active" }));
    await handleStripeEvent(subscriptionEvent("evt_a", "customer.subscription.updated", {}, T), ENV);
    m.retrieveSubscription.mockResolvedValueOnce(sub({ status: "past_due" }));
    await handleStripeEvent(subscriptionEvent("evt_b", "customer.subscription.updated", {}, T), ENV);
    expect(ws().planStatus).toBe("past_due");
  });
});

/**
 * Fix round 3: the workspace is synced from the customer's whole list. The
 * event only says which workspace and customer; the list decides the state.
 */
describe("sync from the customer's list", () => {
  const T = 1799000000;
  const s1 = (overrides: Partial<StripeSubscription> = {}) => sub({ id: "sub_1", created: T - 100, ...overrides });
  const s2 = (overrides: Partial<StripeSubscription> = {}) =>
    sub({
      id: "sub_2",
      created: T - 50,
      items: { data: [{ price: { id: "price_example_growth" }, current_period_end: PERIOD_END }] },
      ...overrides,
    });

  it("lists the subscriptions of the workspace's own customer", async () => {
    m.retrieveSubscription.mockResolvedValue(s1());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    expect(m.listCustomerSubscriptions).toHaveBeenCalledWith("cus_a", ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" });
  });

  it("an attacker's subscription on another customer naming this workspace: nothing written, B's list never read for A", async () => {
    m.retrieveSubscription.mockResolvedValue(s1({ customer: "cus_b" }));
    m.listCustomerSubscriptions.mockResolvedValue([s1({ customer: "cus_b" })]);
    const before = { ...ws() };
    await handleStripeEvent(subscriptionEvent("evt_x", "customer.subscription.created"), ENV);
    expect(ws()).toEqual(before);
  });

  it("two live: the most recently created is used, and the error names the workspace, the ids and the one in use", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    m.retrieveSubscription.mockResolvedValue(s1());
    m.listCustomerSubscriptions.mockResolvedValue([s1(), s2()]);
    await handleStripeEvent(subscriptionEvent("evt_m", "customer.subscription.updated"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" });
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("more than one live subscription"),
      expect.objectContaining({
        eventId: "evt_m",
        workspaceId: "ws_a",
        liveSubscriptionIds: ["sub_2", "sub_1"],
        storedSubscriptionId: "sub_1",
        usingSubscriptionId: "sub_2",
      }),
    );
  });

  it("one live: no error logged", async () => {
    m.retrieveSubscription.mockResolvedValue(s1());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    expect(m.logger.error).not.toHaveBeenCalled();
  });

  it("two live, the stored one is cancelled: the workspace is on the other, active", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" }));
    m.retrieveSubscription.mockResolvedValue(s2({ status: "canceled", ended_at: T }));
    m.listCustomerSubscriptions.mockResolvedValue([s1(), s2({ status: "canceled", ended_at: T })]);
    await handleStripeEvent(subscriptionEvent("evt_d", "customer.subscription.deleted", { id: "sub_2" }), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" });
  });

  it("two live, the other is cancelled: the workspace stays on the stored one, the newest live one left", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" }));
    m.retrieveSubscription.mockResolvedValue(s1({ status: "canceled", ended_at: T }));
    m.listCustomerSubscriptions.mockResolvedValue([s1({ status: "canceled", ended_at: T }), s2()]);
    await handleStripeEvent(subscriptionEvent("evt_o", "customer.subscription.deleted"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" });
  });

  it("an event about a subscription that is not the stored one is synced like any other", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    m.retrieveSubscription.mockResolvedValue(s2({ status: "canceled", ended_at: T }));
    m.listCustomerSubscriptions.mockResolvedValue([s1({ status: "past_due" }), s2({ status: "canceled", ended_at: T })]);
    await handleStripeEvent(subscriptionEvent("evt_n", "customer.subscription.deleted", { id: "sub_2" }), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "past_due" });
  });

  describe("two live, both cancelled close together", () => {
    const bothEnded = () => [s1({ status: "canceled", ended_at: T + 1 }), s2({ status: "canceled", ended_at: T + 2 })];
    const staleForFirst = () => [s1({ status: "canceled", ended_at: T + 1 }), s2()];

    beforeEach(() => {
      m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" }));
    });

    it("the first cancellation's event commits first, then the second's: canceled", async () => {
      m.retrieveSubscription.mockResolvedValueOnce(s1({ status: "canceled", ended_at: T + 1 }));
      m.listCustomerSubscriptions.mockResolvedValueOnce(staleForFirst());
      await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.deleted", { id: "sub_1" }, T + 1), ENV);
      expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "active" });

      m.retrieveSubscription.mockResolvedValueOnce(s2({ status: "canceled", ended_at: T + 2 }));
      m.listCustomerSubscriptions.mockResolvedValueOnce(bothEnded());
      await handleStripeEvent(subscriptionEvent("evt_2", "customer.subscription.deleted", { id: "sub_2" }, T + 2), ENV);
      expect(ws()).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_2", plan: "growth" });
    });

    it("the second's event commits first, then the first's with its stale list: still canceled", async () => {
      m.retrieveSubscription.mockResolvedValueOnce(s2({ status: "canceled", ended_at: T + 2 }));
      m.listCustomerSubscriptions.mockResolvedValueOnce(bothEnded());
      await handleStripeEvent(subscriptionEvent("evt_2", "customer.subscription.deleted", { id: "sub_2" }, T + 2), ENV);

      m.retrieveSubscription.mockResolvedValueOnce(s1({ status: "canceled", ended_at: T + 1 }));
      m.listCustomerSubscriptions.mockResolvedValueOnce(staleForFirst());
      await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.deleted", { id: "sub_1" }, T + 1), ENV);
      expect(ws()).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_2" });
      expect(m.events.has("evt_1")).toBe(true);
    });
  });

  it("the only live candidate has an unconfigured price: not chosen; with an ended one the workspace is canceled; the price is logged", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    const odd = s2({ items: { data: [{ price: { id: "price_example_other" }, current_period_end: PERIOD_END }] } });
    m.retrieveSubscription.mockResolvedValue(odd);
    m.listCustomerSubscriptions.mockResolvedValue([s1({ status: "canceled", ended_at: T }), odd]);
    await handleStripeEvent(subscriptionEvent("evt_p", "customer.subscription.created", { id: "sub_2" }), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "canceled", plan: "starter" });
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("price"),
      expect.objectContaining({ eventId: "evt_p", subscriptionId: "sub_2", priceId: "price_example_other" }),
    );
  });

  it("a live subscription of the customer naming another workspace, or none, is never chosen", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    m.retrieveSubscription.mockResolvedValue(s1({ status: "canceled", ended_at: T }));
    m.listCustomerSubscriptions.mockResolvedValue([
      s1({ status: "canceled", ended_at: T }),
      s2({ metadata: { workspaceId: "ws_b" } }),
      sub({ id: "sub_3", created: T, metadata: {} }),
    ]);
    await handleStripeEvent(subscriptionEvent("evt_c", "customer.subscription.deleted"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "canceled" });
  });

  it("the list call fails: 500, nothing recorded, nothing written", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    const before = { ...ws() };
    m.retrieveSubscription.mockResolvedValue(s1({ status: "canceled" }));
    m.listCustomerSubscriptions.mockRejectedValue(new StripeApiError("Stripe answered 500", 500));
    expect(await handleStripeEvent(subscriptionEvent("evt_l", "customer.subscription.deleted"), ENV)).toBe(500);
    expect(m.events.has("evt_l")).toBe(false);
    expect(ws()).toEqual(before);
  });
});

describe("payloads and collisions (fix round 1, item 9)", () => {
  it("a subscription event with no object id answers 200 and logs that the endpoint must send snapshot payloads", async () => {
    const status = await handleStripeEvent(
      { id: "evt_thin", type: "customer.subscription.updated", related_object: { id: "sub_1" } },
      ENV,
    );
    expect(status).toBe(200);
    expect(m.retrieveSubscription).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("snapshot"), expect.objectContaining({ eventId: "evt_thin" }));
  });

  it("a checkout event with no object logs the same", async () => {
    expect(await handleStripeEvent({ id: "evt_thin2", type: "checkout.session.completed" }, ENV)).toBe(200);
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("snapshot"), expect.objectContaining({ eventId: "evt_thin2" }));
  });

  it("a collision on a unique Stripe id is logged with the event id and answered 200, so it is not retried for days", async () => {
    m.retrieveSubscription.mockResolvedValue(sub());
    m.collideNextUpdate = true;
    expect(await handleStripeEvent(subscriptionEvent("evt_dup", "customer.subscription.updated"), ENV)).toBe(200);
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("unique"),
      expect.objectContaining({ eventId: "evt_dup" }),
    );
  });

  it("writes planEndsAt from the subscription", async () => {
    m.retrieveSubscription.mockResolvedValue(sub({ cancel_at_period_end: true }));
    await handleStripeEvent(subscriptionEvent("evt_c", "customer.subscription.updated"), ENV);
    expect(ws().planEndsAt).toEqual(new Date(PERIOD_END * 1000));
  });
});

describe("invoice.payment_failed", () => {
  const failed = (id: string, invoice = "in_1", customer = "cus_a") => ({
    id,
    type: "invoice.payment_failed",
    data: { object: { id: invoice, object: "invoice", customer } },
  });

  beforeEach(() => {
    m.owners.set("ws_a", [
      { userId: "u1", email: "one@example.com" },
      { userId: "u2", email: "two@example.com" },
    ]);
  });

  it("emails each owner of the customer's workspace, keyed on the invoice", async () => {
    expect(await handleStripeEvent(failed("evt_1"), ENV)).toBe(200);
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    expect(m.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "one@example.com", subject: "We could not charge your card for Surf A" }),
      { idempotencyKey: "stripe-payment-failed/in_1/u1", throwOnRetryable: true },
    );
    expect(m.sendEmail.mock.calls[0][0].html).toContain("Your posts keep going out for 7 days.");
  });

  it("once per invoice: a second event for the same invoice sends nothing", async () => {
    await handleStripeEvent(failed("evt_1"), ENV);
    await handleStripeEvent(failed("evt_2"), ENV);
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    expect(m.events.has("evt_2")).toBe(true);
  });

  it("a new invoice is a new email", async () => {
    await handleStripeEvent(failed("evt_1", "in_1"), ENV);
    await handleStripeEvent(failed("evt_2", "in_2"), ENV);
    expect(m.sendEmail).toHaveBeenCalledTimes(4);
  });

  it("a send that fails answers 500 and records nothing, so Stripe sends it again", async () => {
    m.sendEmail.mockRejectedValueOnce(new Error("resend 503"));
    expect(await handleStripeEvent(failed("evt_1"), ENV)).toBe(500);
    expect(m.events.size).toBe(0);
  });

  it("a customer no workspace has is logged and recorded, nothing sent", async () => {
    expect(await handleStripeEvent(failed("evt_1", "in_1", "cus_unknown"), ENV)).toBe(200);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.events.has("evt_1")).toBe(true);
    expect(m.logger.error).toHaveBeenCalled();
  });
});

describe("other events and bad input", () => {
  it("records and ignores any other type", async () => {
    expect(await handleStripeEvent({ id: "evt_o", type: "invoice.paid", data: { object: {} } }, ENV)).toBe(200);
    expect(m.events.get("evt_o")).toBe("invoice.paid");
    expect(m.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("an event with no id or type is a 400 and records nothing", async () => {
    expect(await handleStripeEvent({ type: "invoice.paid" }, ENV)).toBe(400);
    expect(await handleStripeEvent(null, ENV)).toBe(400);
    expect(m.events.size).toBe(0);
  });

  it("never logs the secrets", async () => {
    m.retrieveSubscription.mockRejectedValue(new StripeApiError("Stripe answered 401", 401));
    await handleStripeEvent(subscriptionEvent("evt_s", "customer.subscription.updated"), ENV);
    m.retrieveSubscription.mockResolvedValue(sub({ customer: "cus_b" }));
    await handleStripeEvent(subscriptionEvent("evt_s2", "customer.subscription.updated"), ENV);
    const logged = JSON.stringify(Object.values(m.logger).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain("sk_test_example");
    expect(logged).not.toContain("whsec_example");
  });
});
