import { describe, expect, it } from "vitest";

import { planState } from "@/lib/billing";

import type { StripeSubscription } from "./stripeApi";
import { isLiveSubscriptionStatus, subscriptionWrite, type SyncWorkspace } from "./subscriptionSync";

const ENV = {
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

const PERIOD_END = 1800000000;
const TRIAL_END = 1799000000;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { workspaceId: "ws_1" },
    trial_end: null,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_example_growth" }, current_period_end: PERIOD_END }] },
    ...overrides,
  };
}

const WS: SyncWorkspace = { id: "ws_1", stripeCustomerId: "cus_1", stripeSubscriptionId: null, billingExempt: false };

describe("subscriptionWrite", () => {
  it("writes plan, status, period end and the subscription id", () => {
    expect(subscriptionWrite(sub(), WS, null, ENV)).toEqual({
      ok: true,
      data: {
        plan: "growth",
        planStatus: "active",
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        stripeSubscriptionId: "sub_1",
      },
      warnings: [],
    });
  });

  it("writes the trial end when the subscription has one", () => {
    const result = subscriptionWrite(sub({ status: "trialing", trial_end: TRIAL_END }), WS, null, ENV);
    expect(result.ok && result.data.trialEndsAt).toEqual(new Date(TRIAL_END * 1000));
    expect(result.ok && result.data.planStatus).toBe("trialing");
  });

  it("maps every Stripe status to the same planStatus", () => {
    for (const status of ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]) {
      const result = subscriptionWrite(sub({ status }), WS, null, ENV);
      expect(result.ok && result.data.planStatus, status).toBe(status);
    }
  });

  it("an unknown status changes nothing", () => {
    expect(subscriptionWrite(sub({ status: "something_new" }), WS, null, ENV)).toMatchObject({ ok: false, level: "error" });
  });

  it("a canceled subscription keeps its plan, so the block says the plan has ended", () => {
    const result = subscriptionWrite(sub({ status: "canceled" }), WS, null, ENV);
    expect(result.ok && result.data).toMatchObject({ plan: "growth", planStatus: "canceled" });
    const now = new Date((PERIOD_END + 10 * 86400) * 1000);
    expect(planState({ ...(result.ok ? result.data : {}), billingExempt: false }, now)).toBe("ended");
  });

  it("an unknown price changes nothing and is an error", () => {
    const result = subscriptionWrite(
      sub({ items: { data: [{ price: { id: "price_example_other" }, current_period_end: PERIOD_END }] } }),
      WS,
      null,
      ENV,
    );
    expect(result).toMatchObject({ ok: false, level: "error" });
  });

  it("no item changes nothing", () => {
    expect(subscriptionWrite(sub({ items: { data: [] } }), WS, null, ENV)).toMatchObject({ ok: false, level: "error" });
  });

  it("refuses a subscription whose metadata names workspace A but whose customer is B's", () => {
    const result = subscriptionWrite(sub({ customer: "cus_of_b" }), WS, null, ENV);
    expect(result).toMatchObject({ ok: false, level: "error" });
  });

  it("refuses when the named workspace does not exist", () => {
    expect(subscriptionWrite(sub(), null, null, ENV)).toMatchObject({ ok: false, level: "error" });
  });

  it("refuses a workspace with no customer unless the checkout session names it", () => {
    const noCustomer = { ...WS, stripeCustomerId: null };
    expect(subscriptionWrite(sub(), noCustomer, null, ENV)).toMatchObject({ ok: false, level: "error" });
    expect(
      subscriptionWrite(sub(), noCustomer, { workspaceId: "ws_other", customer: "cus_1", subscription: "sub_1" }, ENV),
    ).toMatchObject({ ok: false });
    expect(
      subscriptionWrite(sub(), noCustomer, { workspaceId: "ws_1", customer: "cus_other", subscription: "sub_1" }, ENV),
    ).toMatchObject({ ok: false });
    expect(
      subscriptionWrite(sub(), noCustomer, { workspaceId: "ws_1", customer: "cus_1", subscription: "sub_other" }, ENV),
    ).toMatchObject({ ok: false });
  });

  it("binds the customer when the workspace has none and the checkout session names it", () => {
    const result = subscriptionWrite(
      sub(),
      { ...WS, stripeCustomerId: null },
      { workspaceId: "ws_1", customer: "cus_1", subscription: "sub_1" },
      ENV,
    );
    expect(result.ok && result.data.stripeCustomerId).toBe("cus_1");
  });

  it("a checkout claim never overrides a workspace that already has another customer", () => {
    const result = subscriptionWrite(
      sub({ customer: "cus_other" }),
      WS,
      { workspaceId: "ws_1", customer: "cus_other", subscription: "sub_1" },
      ENV,
    );
    expect(result).toMatchObject({ ok: false, level: "error" });
  });

  it("accepts an expanded customer object", () => {
    expect(subscriptionWrite(sub({ customer: { id: "cus_1" } }), WS, null, ENV).ok).toBe(true);
  });

  it("an ended old subscription does not overwrite the workspace's newer one", () => {
    const result = subscriptionWrite(
      sub({ id: "sub_old", status: "canceled" }),
      { ...WS, stripeSubscriptionId: "sub_new" },
      null,
      ENV,
    );
    expect(result).toMatchObject({ ok: false, level: "info" });
  });

  it("a live new subscription replaces an ended one", () => {
    const result = subscriptionWrite(sub({ id: "sub_new" }), { ...WS, stripeSubscriptionId: "sub_old" }, null, ENV);
    expect(result.ok && result.data.stripeSubscriptionId).toBe("sub_new");
  });

  it("a plan change on the same subscription writes the new plan", () => {
    const result = subscriptionWrite(
      sub({ items: { data: [{ price: { id: "price_example_pro" }, current_period_end: PERIOD_END }] } }),
      { ...WS, stripeSubscriptionId: "sub_1" },
      null,
      ENV,
    );
    expect(result.ok && result.data.plan).toBe("pro");
  });

  it("writes onto a workspace exempt by its flag but warns: the plan's limits do not apply until the flag is cleared", () => {
    const result = subscriptionWrite(sub(), { ...WS, billingExempt: true }, null, ENV);
    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings.length).toBe(1);
  });

  it("a workspace exempt only by having no plan and no trial is active once the plan is written", () => {
    const before = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };
    const now = new Date((PERIOD_END - 86400) * 1000);
    expect(planState(before, now)).toBe("exempt");
    const result = subscriptionWrite(sub(), WS, null, ENV);
    expect(planState({ ...before, ...(result.ok ? result.data : {}) }, now)).toBe("active");
  });
});

describe("isLiveSubscriptionStatus", () => {
  it("is false only for the two ended statuses and anything unknown", () => {
    for (const status of ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"]) {
      expect(isLiveSubscriptionStatus(status), status).toBe(true);
    }
    for (const status of ["canceled", "incomplete_expired", "something_new", null, undefined]) {
      expect(isLiveSubscriptionStatus(status), String(status)).toBe(false);
    }
  });
});
