import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook's handling of a verified event (fix round 4), against:
 * - an in-memory database whose $transaction runs one at a time (as the
 *   workspace row lock makes them), works on copies and publishes them only
 *   on success (a throw rolls back);
 * - a Stripe "world" of subscriptions that retrieveSubscription and
 *   listAllCustomerSubscriptions read, and that a test can change between
 *   reads to model Stripe moving on while a handler runs.
 * Email goes only through the mocked sendEmail.
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
};

type Sub = import("./stripeApi").StripeSubscription;

const m = vi.hoisted(() => ({
  events: new Map<string, string>(),
  workspaces: new Map<string, Row>(),
  owners: new Map<string, Array<{ userId: string; email: string }>>(),
  world: new Map<string, Sub>(),
  calls: [] as string[],
  sql: [] as string[],
  listFails: null as Error | null,
  listIncomplete: false,
  /** Runs after each list call returns; lets a test move Stripe on. */
  afterList: null as null | ((count: number) => void),
  listCount: 0,
  txOptions: [] as unknown[],
  chain: Promise.resolve() as Promise<unknown>,
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
vi.mock("./stripeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stripeApi")>();
  return {
    ...actual,
    retrieveSubscription: vi.fn(async (id: string) => {
      m.calls.push(`retrieve:${id}`);
      const found = m.world.get(id);
      if (!found) throw new actual.StripeApiError("Stripe answered 404 (resource_missing)", 404, "resource_missing");
      return structuredClone(found);
    }),
    listAllCustomerSubscriptions: vi.fn(async (customer: string) => {
      m.calls.push(`list:${customer}`);
      if (m.listFails) throw m.listFails;
      const data = [...m.world.values()]
        .filter((s) => s.customer === customer)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((s) => structuredClone(s));
      m.listCount++;
      m.afterList?.(m.listCount);
      return { data, complete: !m.listIncomplete };
    }),
  };
});
vi.mock("@/lib/db", () => {
  function client(events: Map<string, string>, workspaces: Map<string, Row>) {
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        m.sql.push(sql);
        m.calls.push(`${sql.includes("FOR NO KEY UPDATE") ? "lock" : "sql"}:${String(values[0])}`);
        return 1;
      },
      stripeEvent: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          events.has(where.id) ? { id: where.id, type: events.get(where.id) } : null,
        createMany: async ({ data }: { data: Array<{ id: string; type: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (!events.has(row.id)) {
              events.set(row.id, row.type);
              m.calls.push(`record:${row.id}`);
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
          m.calls.push(`write:${where.id}`);
          return workspaces.get(where.id);
        },
      },
    };
  }
  const prisma = {
    ...client(m.events, m.workspaces),
    $transaction: (cb: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      m.txOptions.push(options);
      // One at a time, as the workspace row lock makes them.
      const run = m.chain.then(async () => {
        const events = new Map(m.events);
        const workspaces = new Map([...m.workspaces].map(([k, v]) => [k, { ...v }]));
        const result = await cb(client(events, workspaces));
        m.events.clear();
        for (const [k, v] of events) m.events.set(k, v);
        m.workspaces.clear();
        for (const [k, v] of workspaces) m.workspaces.set(k, v);
        return result;
      });
      m.chain = run.catch(() => undefined);
      return run;
    },
  };
  return { prisma };
});

import { handleStripeEvent } from "./stripeWebhook";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

const DAY = 86400;
const T = 1798000000;
const PERIOD_START = 1799000000;
const PERIOD_END = PERIOD_START + 30 * DAY;

/** A realistic subscription for workspace ws_a on customer cus_a. */
function sub(overrides: Partial<Sub> = {}): Sub {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_a",
    created: T,
    ended_at: null,
    canceled_at: null,
    cancel_at: null,
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { workspaceId: "ws_a" },
    items: {
      data: [{ price: { id: "price_example_starter" }, current_period_start: PERIOD_START, current_period_end: PERIOD_END }],
    },
    ...overrides,
  };
}

const priced = (price: string, start = PERIOD_START, end = PERIOD_END) => ({
  items: { data: [{ price: { id: price }, current_period_start: start, current_period_end: end }] },
});

/** Puts subscriptions into Stripe's world, replacing any with the same id. */
const stripeHas = (...subs: Sub[]) => {
  for (const s of subs) m.world.set(s.id, s);
};

function subscriptionEvent(id: string, type: string, subscriptionId = "sub_1") {
  // The payload deliberately disagrees with Stripe: it must not be read.
  return { id, type, created: T, data: { object: { id: subscriptionId, object: "subscription", status: "incomplete" } } };
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
const stripeCalls = () => m.calls.filter((c) => c.startsWith("retrieve:") || c.startsWith("list:"));

beforeEach(() => {
  m.events.clear();
  m.workspaces.clear();
  m.owners.clear();
  m.world.clear();
  m.calls = [];
  m.sql = [];
  m.listFails = null;
  m.listIncomplete = false;
  m.afterList = null;
  m.listCount = 0;
  m.txOptions = [];
  m.chain = Promise.resolve();
  m.failNextUpdate = false;
  m.collideNextUpdate = false;
  m.sendEmail.mockReset();
  m.sendEmail.mockResolvedValue(undefined);
  for (const fn of Object.values(m.logger)) fn.mockReset();
  m.workspaces.set("ws_a", row());
  m.workspaces.set("ws_b", row({ id: "ws_b", name: "Surf B", stripeCustomerId: "cus_b" }));
});

describe("how a subscription event is handled", () => {
  it("identifies the workspace, then under its row lock records the event, reads Stripe again, lists and writes", async () => {
    stripeHas(sub());
    expect(await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV)).toBe(200);
    expect(m.calls).toEqual(["retrieve:sub_1", "lock:ws_a", "record:evt_1", "retrieve:sub_1", "list:cus_a", "write:ws_a"]);
  });

  it("the lock is FOR NO KEY UPDATE on the workspace row, so inserts that reference the workspace are not blocked", async () => {
    stripeHas(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    expect(m.sql).toEqual(['SELECT 1 FROM "Workspace" WHERE "id" = ? FOR NO KEY UPDATE']);
  });

  it("the transaction gets a timeout long enough for its Stripe calls", async () => {
    stripeHas(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    const options = m.txOptions[0] as { timeout: number; maxWait: number };
    expect(options.timeout).toBeGreaterThanOrEqual(45_000);
    expect(options.maxWait).toBeGreaterThan(0);
  });

  it("lists the subscriptions of the workspace's own customer", async () => {
    stripeHas(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.created"), ENV);
    expect(stripeCalls()).toContain("list:cus_a");
  });

  it("checkout.session.completed fetches the session's subscription", async () => {
    stripeHas(sub({ id: "sub_9" }));
    const status = await handleStripeEvent(
      {
        id: "evt_c",
        type: "checkout.session.completed",
        created: T,
        data: { object: { id: "cs_1", mode: "subscription", subscription: "sub_9", client_reference_id: "ws_a", customer: "cus_a" } },
      },
      ENV,
    );
    expect(status).toBe(200);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_9", plan: "starter", planStatus: "active" });
  });

  it("checkout.session.completed for a workspace with no customer yet: the customer is attached and the plan written", async () => {
    m.workspaces.set("ws_a", row({ stripeCustomerId: null }));
    stripeHas(sub());
    await handleStripeEvent(
      {
        id: "evt_c",
        type: "checkout.session.completed",
        created: T,
        data: { object: { id: "cs_2", mode: "subscription", subscription: "sub_1", client_reference_id: "ws_a", customer: "cus_a" } },
      },
      ENV,
    );
    expect(ws()).toMatchObject({ stripeCustomerId: "cus_a", plan: "starter", planStatus: "active" });
  });

  it("a payment-mode checkout session is recorded and ignored, with no Stripe call", async () => {
    const status = await handleStripeEvent(
      { id: "evt_p", type: "checkout.session.completed", data: { object: { id: "cs_p", mode: "payment", subscription: null } } },
      ENV,
    );
    expect(status).toBe(200);
    expect(stripeCalls()).toEqual([]);
    expect(m.events.has("evt_p")).toBe(true);
  });
});

describe("one subscription through its life", () => {
  const step = async (n: number, state: Partial<Sub>) => {
    stripeHas(sub(state));
    return handleStripeEvent(subscriptionEvent(`evt_${n}`, "customer.subscription.updated"), ENV);
  };

  it("trialing, active, renewed, past_due, paid again, cancel at period end, cancelled, unpaid", async () => {
    await step(1, { status: "trialing", trial_end: PERIOD_START });
    expect(ws()).toMatchObject({ planStatus: "trialing", trialEndsAt: new Date(PERIOD_START * 1000), plan: "starter" });

    await step(2, { status: "active" });
    expect(ws()).toMatchObject({ planStatus: "active", currentPeriodEnd: new Date(PERIOD_END * 1000) });

    await step(3, priced("price_example_starter", PERIOD_END, PERIOD_END + 30 * DAY));
    expect(ws().currentPeriodEnd).toEqual(new Date((PERIOD_END + 30 * DAY) * 1000));

    await step(4, { status: "past_due", ...priced("price_example_starter", PERIOD_END, PERIOD_END + 30 * DAY) });
    // The grace runs from the end of the last paid period, the failed renewal.
    expect(ws()).toMatchObject({ planStatus: "past_due", currentPeriodEnd: new Date(PERIOD_END * 1000) });

    await step(5, priced("price_example_starter", PERIOD_END, PERIOD_END + 30 * DAY));
    expect(ws()).toMatchObject({ planStatus: "active", currentPeriodEnd: new Date((PERIOD_END + 30 * DAY) * 1000) });

    await step(6, { cancel_at_period_end: true, ...priced("price_example_starter", PERIOD_END, PERIOD_END + 30 * DAY) });
    expect(ws()).toMatchObject({ planStatus: "active", planEndsAt: new Date((PERIOD_END + 30 * DAY) * 1000) });

    await step(7, { status: "canceled", ended_at: PERIOD_END + 30 * DAY, canceled_at: PERIOD_END });
    expect(ws()).toMatchObject({ planStatus: "canceled", plan: "starter" });

    await step(8, { status: "unpaid" });
    expect(ws()).toMatchObject({ planStatus: "unpaid", plan: "starter" });
  });
});

describe("choosing among the workspace's subscriptions", () => {
  it("an old-price subscription in use with an older ended one: nothing changes, error logged with the price id", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" }));
    const before = { ...ws() };
    stripeHas(
      sub({ id: "sub_1", created: T, status: "canceled", ended_at: T + DAY }),
      sub({ id: "sub_2", created: T + 2 * DAY, ...priced("price_example_legacy") }),
    );
    expect(await handleStripeEvent(subscriptionEvent("evt_l", "customer.subscription.updated", "sub_2"), ENV)).toBe(200);
    expect(ws()).toEqual(before);
    expect(m.events.has("evt_l")).toBe(true);
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("price"),
      expect.objectContaining({ eventId: "evt_l", workspaceId: "ws_a", subscriptionId: "sub_2", priceId: "price_example_legacy" }),
    );
  });

  it("active (older) and past_due (newer): the workspace stays active on the older one", async () => {
    stripeHas(
      sub({ id: "sub_1", created: T }),
      sub({ id: "sub_2", created: T + DAY, status: "past_due", ...priced("price_example_pro") }),
    );
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated", "sub_2"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "active", plan: "starter" });
  });

  it("two live: the newer is used, and the error names the workspace, the ids and the one in use", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    stripeHas(sub({ id: "sub_1", created: T }), sub({ id: "sub_2", created: T + DAY, ...priced("price_example_growth") }));
    await handleStripeEvent(subscriptionEvent("evt_m", "customer.subscription.updated"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "growth" });
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

  it("two live, each cancelled in turn: on the other, then canceled", async () => {
    stripeHas(sub({ id: "sub_1", created: T }), sub({ id: "sub_2", created: T + DAY, ...priced("price_example_growth") }));
    stripeHas(sub({ id: "sub_1", created: T, status: "canceled", ended_at: T + 3 * DAY }));
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.deleted", "sub_1"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "active" });

    stripeHas(sub({ id: "sub_2", created: T + DAY, status: "canceled", ended_at: T + 4 * DAY, ...priced("price_example_growth") }));
    await handleStripeEvent(subscriptionEvent("evt_2", "customer.subscription.deleted", "sub_2"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "canceled", plan: "growth" });
  });

  describe("two live, both cancelled close together, the two handlers overlapping", () => {
    const live2 = () => sub({ id: "sub_2", created: T + DAY, ...priced("price_example_growth") });
    const ended1 = () => sub({ id: "sub_1", created: T, status: "canceled", ended_at: T + 3 * DAY });
    const ended2 = () => sub({ id: "sub_2", created: T + DAY, status: "canceled", ended_at: T + 3 * DAY + 1, ...priced("price_example_growth") });

    beforeEach(() => {
      m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_2", plan: "growth", planStatus: "active" }));
      // When the handlers start, only sub_1 is cancelled; sub_2 is cancelled
      // while the first handler is inside its transaction, so the two read
      // different answers from Stripe.
      stripeHas(ended1(), live2());
      m.afterList = (count) => {
        if (count === 1) stripeHas(ended2());
      };
    });

    for (const [name, first, second] of [
      ["sub_1's event first", "sub_1", "sub_2"],
      ["sub_2's event first", "sub_2", "sub_1"],
    ] as const) {
      it(`${name}: the workspace ends canceled`, async () => {
        const handled = Promise.all([
          handleStripeEvent(subscriptionEvent(`evt_${first}`, "customer.subscription.deleted", first), ENV),
          handleStripeEvent(subscriptionEvent(`evt_${second}`, "customer.subscription.deleted", second), ENV),
        ]);
        expect(await handled).toEqual([200, 200]);
        // Two handlers, two lists: the first saw sub_2 still active, the second saw both ended.
        expect(m.listCount).toBe(2);
        expect(ws()).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_2", plan: "growth" });
        // The locks were taken in turn: no Stripe read of one handler happens inside the other's.
        const locks = m.calls.map((c, i) => (c.startsWith("lock:") ? i : -1)).filter((i) => i >= 0);
        expect(locks).toHaveLength(2);
        const between = m.calls.slice(locks[0], locks[1]);
        expect(between.filter((c) => c.startsWith("list:"))).toHaveLength(1);
      });
    }
  });

  it("the event's subscription is missing from the list: it is merged and synced", async () => {
    stripeHas(sub({ id: "sub_9", created: T + 9 * DAY }));
    // Stripe's list has not caught up with the subscription just made.
    const { listAllCustomerSubscriptions } = await import("./stripeApi");
    vi.mocked(listAllCustomerSubscriptions).mockImplementationOnce(async (customer: string) => {
      m.calls.push(`list:${customer}`);
      return { data: [], complete: true };
    });
    await handleStripeEvent(subscriptionEvent("evt_9", "customer.subscription.created", "sub_9"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_9", planStatus: "active" });
  });

  it("a live subscription of the customer naming another workspace, or none, is never chosen", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    stripeHas(
      sub({ id: "sub_1", status: "canceled", ended_at: T + DAY }),
      sub({ id: "sub_2", created: T + 2 * DAY, metadata: { workspaceId: "ws_b" } }),
      sub({ id: "sub_3", created: T + 3 * DAY, metadata: {} }),
    );
    await handleStripeEvent(subscriptionEvent("evt_c", "customer.subscription.deleted"), ENV);
    expect(ws()).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "canceled" });
  });
});

describe("when Stripe's list cannot be read", () => {
  it("fails with an ended event subscription: the cancel is written from that subscription alone", async () => {
    m.workspaces.set("ws_a", row({ stripeSubscriptionId: "sub_1", plan: "starter", planStatus: "active" }));
    stripeHas(sub({ status: "canceled", ended_at: T + DAY }));
    m.listFails = new Error("Stripe answered 500");
    expect(await handleStripeEvent(subscriptionEvent("evt_c", "customer.subscription.deleted"), ENV)).toBe(200);
    expect(ws()).toMatchObject({ planStatus: "canceled", plan: "starter" });
    expect(m.events.has("evt_c")).toBe(true);
  });

  it("fails with a live event subscription: 500, nothing recorded, nothing written", async () => {
    const before = { ...ws() };
    stripeHas(sub());
    m.listFails = new Error("Stripe answered 500");
    expect(await handleStripeEvent(subscriptionEvent("evt_l", "customer.subscription.updated"), ENV)).toBe(500);
    expect(m.events.has("evt_l")).toBe(false);
    expect(ws()).toEqual(before);
  });

  it("more pages than are read: nothing changes, error logged, recorded", async () => {
    const before = { ...ws() };
    stripeHas(sub());
    m.listIncomplete = true;
    expect(await handleStripeEvent(subscriptionEvent("evt_p", "customer.subscription.updated"), ENV)).toBe(200);
    expect(ws()).toEqual(before);
    expect(m.logger.error).toHaveBeenCalled();
  });
});

describe("replays", () => {
  it("an event already in the table is answered with no Stripe call at all", async () => {
    stripeHas(sub());
    await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV);
    m.calls = [];
    expect(await handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV)).toBe(200);
    expect(stripeCalls()).toEqual([]);
  });

  it("the same event delivered twice at once: the second stops at the event table inside the lock", async () => {
    stripeHas(sub());
    const results = await Promise.all([
      handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV),
      handleStripeEvent(subscriptionEvent("evt_1", "customer.subscription.updated"), ENV),
    ]);
    expect(results).toEqual([200, 200]);
    expect(m.calls.filter((c) => c.startsWith("list:"))).toHaveLength(1);
    expect(m.calls.filter((c) => c.startsWith("write:"))).toHaveLength(1);
  });
});

describe("every refusal leaves the workspace's columns exactly as they were", () => {
  const stored = () => row({ stripeSubscriptionId: "sub_1", plan: "growth", planStatus: "active", currentPeriodEnd: new Date(PERIOD_END * 1000) });

  for (const [name, arrange, expectedStatus] of [
    ["B's customer on a subscription naming A", () => stripeHas(sub({ customer: "cus_b" })), 200],
    ["a subscription naming no workspace", () => stripeHas(sub({ metadata: {} })), 200],
    ["a subscription naming a workspace that does not exist", () => stripeHas(sub({ metadata: { workspaceId: "ws_gone" } })), 200],
    ["an in-use subscription on an unknown price", () => stripeHas(sub(priced("price_example_legacy"))), 200],
    ["the identifying fetch fails", () => undefined, 500],
    ["the list is incomplete", () => {
      stripeHas(sub());
      m.listIncomplete = true;
    }, 200],
    ["the list fails with a live subscription", () => {
      stripeHas(sub());
      m.listFails = new Error("Stripe answered 503");
    }, 500],
  ] as const) {
    it(name, async () => {
      m.workspaces.set("ws_a", stored());
      const before = { ...ws() };
      const beforeB = { ...ws("ws_b") };
      arrange();
      expect(await handleStripeEvent(subscriptionEvent("evt_r", "customer.subscription.updated"), ENV)).toBe(expectedStatus);
      expect(ws()).toEqual(before);
      expect(ws("ws_b")).toEqual(beforeB);
    });
  }

  it("a failed write answers 500 and records nothing", async () => {
    m.workspaces.set("ws_a", stored());
    const before = { ...ws() };
    stripeHas(sub());
    m.failNextUpdate = true;
    expect(await handleStripeEvent(subscriptionEvent("evt_w", "customer.subscription.updated"), ENV)).toBe(500);
    expect(m.events.has("evt_w")).toBe(false);
    expect(ws()).toEqual(before);
  });

  it("a Stripe failure inside the transaction rolls back the event record", async () => {
    stripeHas(sub());
    const { retrieveSubscription } = await import("./stripeApi");
    const real = vi.mocked(retrieveSubscription).getMockImplementation()!;
    let n = 0;
    vi.mocked(retrieveSubscription).mockImplementation(async (id, env) => {
      n++;
      if (n === 2) throw new Error("Stripe could not be reached");
      return real(id, env);
    });
    expect(await handleStripeEvent(subscriptionEvent("evt_s", "customer.subscription.updated"), ENV)).toBe(500);
    expect(m.events.has("evt_s")).toBe(false);
    vi.mocked(retrieveSubscription).mockImplementation(real);
  });
});

describe("writing", () => {
  it("an exempt-flag workspace gets the subscription written and an error logged for the operator", async () => {
    m.workspaces.set("ws_a", row({ billingExempt: true }));
    stripeHas(sub());
    await handleStripeEvent(subscriptionEvent("evt_e", "customer.subscription.created"), ENV);
    expect(ws().plan).toBe("starter");
    expect(m.logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: "evt_e", workspaceId: "ws_a" }));
  });

  it("a collision on a unique Stripe id is logged with the event id and answered 200", async () => {
    stripeHas(sub());
    m.collideNextUpdate = true;
    expect(await handleStripeEvent(subscriptionEvent("evt_dup", "customer.subscription.updated"), ENV)).toBe(200);
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("unique"), expect.objectContaining({ eventId: "evt_dup" }));
  });
});

describe("payloads", () => {
  it("a subscription event with no object id answers 200 and logs that the endpoint must send snapshot payloads", async () => {
    const status = await handleStripeEvent({ id: "evt_thin", type: "customer.subscription.updated", related_object: { id: "sub_1" } }, ENV);
    expect(status).toBe(200);
    expect(stripeCalls()).toEqual([]);
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("snapshot"), expect.objectContaining({ eventId: "evt_thin" }));
  });

  it("a checkout event with no object logs the same", async () => {
    expect(await handleStripeEvent({ id: "evt_thin2", type: "checkout.session.completed" }, ENV)).toBe(200);
    expect(m.logger.error).toHaveBeenCalledWith(expect.stringContaining("snapshot"), expect.objectContaining({ eventId: "evt_thin2" }));
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
    expect(stripeCalls()).toEqual([]);
  });

  it("an event with no id or type is a 400 and records nothing", async () => {
    expect(await handleStripeEvent({ type: "invoice.paid" }, ENV)).toBe(400);
    expect(await handleStripeEvent(null, ENV)).toBe(400);
    expect(m.events.size).toBe(0);
  });

  it("never logs the secrets", async () => {
    await handleStripeEvent(subscriptionEvent("evt_s", "customer.subscription.updated"), ENV);
    stripeHas(sub({ customer: "cus_b" }));
    await handleStripeEvent(subscriptionEvent("evt_s2", "customer.subscription.updated"), ENV);
    const logged = JSON.stringify(Object.values(m.logger).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain("sk_test_example");
    expect(logged).not.toContain("whsec_example");
  });
});
