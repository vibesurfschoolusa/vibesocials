import { describe, expect, it } from "vitest";

import { planState } from "@/lib/billing";

import type { StripeSubscription } from "./stripeApi";
import { isLiveSubscriptionStatus, syncFromCustomerList, type SyncWorkspace } from "./subscriptionSync";

/**
 * What the webhook writes, from the customer's list of subscriptions (fix
 * round 4). The describe and test names read as the specification.
 */

const ENV = {
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

const T0 = 1798000000;
const DAY = 86400;
const PERIOD_START = 1799000000;
const PERIOD_END = PERIOD_START + 30 * DAY;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: T0,
    ended_at: null,
    canceled_at: null,
    metadata: { workspaceId: "ws_1" },
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [{ price: { id: "price_example_growth" }, current_period_start: PERIOD_START, current_period_end: PERIOD_END }],
    },
    ...overrides,
  };
}

const priced = (price: string, start = PERIOD_START, end = PERIOD_END) => ({
  items: { data: [{ price: { id: price }, current_period_start: start, current_period_end: end }] },
});

const WS: SyncWorkspace = { id: "ws_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", billingExempt: false };

const sync = (about: StripeSubscription, list: StripeSubscription[], workspace: SyncWorkspace | null = WS, complete = true) =>
  syncFromCustomerList(about, workspace, null, list, ENV, complete);

const dataOf = (result: ReturnType<typeof sync>) => (result.ok ? result.data : null);
const stateAt = (data: Record<string, unknown> | null, seconds: number) =>
  planState({ billingExempt: false, ...(data ?? {}) }, new Date(seconds * 1000));

describe("one subscription through its life", () => {
  it("trialing: trialing, with its trial end", () => {
    const s = sub({ status: "trialing", trial_end: PERIOD_END });
    expect(dataOf(sync(s, [s]))).toEqual({
      plan: "growth",
      planStatus: "trialing",
      currentPeriodEnd: new Date(PERIOD_END * 1000),
      planEndsAt: null,
      trialEndsAt: new Date(PERIOD_END * 1000),
      stripeSubscriptionId: "sub_1",
    });
  });

  it("active: active, renews at the period end", () => {
    const s = sub();
    expect(dataOf(sync(s, [s]))).toMatchObject({ planStatus: "active", currentPeriodEnd: new Date(PERIOD_END * 1000), planEndsAt: null });
  });

  it("renewed: the new period end", () => {
    const s = sub(priced("price_example_growth", PERIOD_END, PERIOD_END + 30 * DAY));
    expect(dataOf(sync(s, [s]))?.currentPeriodEnd).toEqual(new Date((PERIOD_END + 30 * DAY) * 1000));
  });

  it("past_due: the date is the end of the last paid period, so posting stops 7 days after the failed renewal", () => {
    const s = sub({ status: "past_due", ...priced("price_example_growth", PERIOD_END, PERIOD_END + 30 * DAY) });
    const data = dataOf(sync(s, [s]));
    expect(data?.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
    expect(stateAt(data, PERIOD_END + 6 * DAY)).toBe("active");
    expect(stateAt(data, PERIOD_END + 7 * DAY + 60)).toBe("ended");
  });

  it("paid again: active with the new period end", () => {
    const s = sub(priced("price_example_growth", PERIOD_END, PERIOD_END + 30 * DAY));
    const data = dataOf(sync(s, [s]));
    expect(data).toMatchObject({ planStatus: "active", currentPeriodEnd: new Date((PERIOD_END + 30 * DAY) * 1000) });
    expect(stateAt(data, PERIOD_END + 20 * DAY)).toBe("active");
  });

  it("cancel at period end: still active, with the plan end", () => {
    const s = sub({ cancel_at_period_end: true });
    expect(dataOf(sync(s, [s]))).toMatchObject({ planStatus: "active", planEndsAt: new Date(PERIOD_END * 1000) });
  });

  it("a set cancel date is the plan end; undoing it clears the plan end", () => {
    const s = sub({ cancel_at: PERIOD_END - DAY });
    expect(dataOf(sync(s, [s]))?.planEndsAt).toEqual(new Date((PERIOD_END - DAY) * 1000));
    const undone = sub();
    expect(dataOf(sync(undone, [undone]))?.planEndsAt).toBeNull();
  });

  it("cancelled: canceled, the plan kept, so the block says the plan has ended", () => {
    const s = sub({ status: "canceled", ended_at: PERIOD_END, canceled_at: PERIOD_END });
    const data = dataOf(sync(s, [s]));
    expect(data).toMatchObject({ plan: "growth", planStatus: "canceled", stripeSubscriptionId: "sub_1" });
    expect(stateAt(data, PERIOD_END + DAY)).toBe("ended");
  });

  it("unpaid: written as unpaid, which reads as ended", () => {
    const s = sub({ status: "unpaid" });
    const data = dataOf(sync(s, [s]));
    expect(data?.planStatus).toBe("unpaid");
    expect(stateAt(data, PERIOD_START + DAY)).toBe("ended");
  });

  it("every status not in use is written as Stripe has it, and reads as ended", () => {
    for (const status of ["incomplete", "incomplete_expired", "canceled", "unpaid", "paused"]) {
      const s = sub({ status });
      const data = dataOf(sync(s, [s]));
      expect(data?.planStatus, status).toBe(status);
      expect(stateAt(data, PERIOD_START + DAY), status).toBe("ended");
    }
  });
});

describe("a subscription in use on a price that is not configured", () => {
  it("with an older ended one: nothing changes, and the price is reported", () => {
    const old = sub({ id: "sub_2", created: T0 + DAY, ...priced("price_example_legacy") });
    const ended = sub({ id: "sub_1", status: "canceled", ended_at: T0 + 2 * DAY });
    const result = sync(old, [old, ended]);
    expect(result).toMatchObject({ ok: false, level: "error" });
    expect(result.unconfigured).toEqual([{ subscriptionId: "sub_2", priceId: "price_example_legacy" }]);
  });

  it("alone: nothing changes", () => {
    const old = sub(priced("price_example_legacy"));
    expect(sync(old, [old])).toMatchObject({ ok: false, level: "error" });
  });

  it("next to another one in use on a known price: still nothing changes", () => {
    const old = sub({ id: "sub_2", ...priced("price_example_legacy") });
    expect(sync(sub(), [sub(), old])).toMatchObject({ ok: false, level: "error" });
  });

  it("an ended one on an unknown price is fine: canceled, the stored plan kept", () => {
    const ended = sub({ status: "canceled", ended_at: T0 + DAY, ...priced("price_example_legacy") });
    const data = dataOf(sync(ended, [ended]));
    expect(data).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_1" });
    expect(data && "plan" in data).toBe(false);
  });
});

describe("choosing among subscriptions in use", () => {
  it("active (older) and past_due (newer): the workspace stays active on the older one", () => {
    const active = sub({ id: "sub_1", created: T0 });
    const pastDue = sub({ id: "sub_2", created: T0 + DAY, status: "past_due", ...priced("price_example_pro") });
    expect(dataOf(sync(pastDue, [active, pastDue]))).toMatchObject({ stripeSubscriptionId: "sub_1", planStatus: "active" });
  });

  it("trialing counts with active, ahead of past_due", () => {
    const trialing = sub({ id: "sub_1", created: T0, status: "trialing" });
    const pastDue = sub({ id: "sub_2", created: T0 + DAY, status: "past_due" });
    expect(dataOf(sync(trialing, [trialing, pastDue]))?.stripeSubscriptionId).toBe("sub_1");
  });

  it("two active: the most recently created, and both are reported", () => {
    const a = sub({ id: "sub_1", created: T0 });
    const b = sub({ id: "sub_2", created: T0 + DAY, ...priced("price_example_pro") });
    const result = sync(a, [a, b]);
    expect(dataOf(result)).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "pro" });
    expect(result.ok && result.liveCandidateIds).toEqual(["sub_2", "sub_1"]);
  });

  it("two in use, one cancelled: the one left in use", () => {
    const a = sub({ id: "sub_1", created: T0, status: "canceled", ended_at: T0 + 3 * DAY });
    const b = sub({ id: "sub_2", created: T0 + DAY });
    expect(dataOf(sync(a, [a, b]))).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "active" });
    expect(dataOf(sync(b, [a, b]))).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "active" });
  });
});

describe("none in use: the one that ended most recently", () => {
  it("both cancelled: the later ended_at, with its real status", () => {
    const a = sub({ id: "sub_1", status: "canceled", ended_at: T0 + 5 * DAY });
    const b = sub({ id: "sub_2", status: "unpaid", created: T0 + DAY, ended_at: null, canceled_at: T0 + 6 * DAY });
    for (const about of [a, b]) {
      expect(dataOf(sync(about, [a, b])), about.id).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "unpaid" });
    }
  });

  it("ranked by ended_at, else canceled_at, else created", () => {
    const a = sub({ id: "sub_1", status: "canceled", canceled_at: T0 + 9 * DAY });
    const b = sub({ id: "sub_2", status: "canceled", ended_at: T0 + 8 * DAY });
    expect(dataOf(sync(a, [a, b]))?.stripeSubscriptionId).toBe("sub_1");
    const c = sub({ id: "sub_1", status: "incomplete_expired", created: T0 });
    const d = sub({ id: "sub_2", status: "incomplete_expired", created: T0 + DAY });
    expect(dataOf(sync(c, [c, d]))?.stripeSubscriptionId).toBe("sub_2");
  });
});

describe("the candidates", () => {
  it("the event's own subscription is merged in when the list lacks it", () => {
    const fresh = sub({ id: "sub_9", created: T0 + 9 * DAY });
    expect(dataOf(sync(fresh, [sub({ status: "canceled", ended_at: T0 + DAY })]))?.stripeSubscriptionId).toBe("sub_9");
  });

  it("the event's own subscription replaces the list's copy of it", () => {
    const stale = sub({ status: "active" });
    const fresh = sub({ status: "canceled", ended_at: T0 + DAY });
    expect(dataOf(sync(fresh, [stale]))?.planStatus).toBe("canceled");
  });

  it("a subscription of the customer naming another workspace, or none, is never a candidate", () => {
    const mine = sub({ status: "canceled", ended_at: T0 + DAY });
    const other = sub({ id: "sub_8", created: T0 + 5 * DAY, metadata: { workspaceId: "ws_2" } });
    const bare = sub({ id: "sub_7", created: T0 + 6 * DAY, metadata: {} });
    expect(dataOf(sync(mine, [mine, other, bare]))).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_1" });
  });

  it("a subscription on another customer is never a candidate", () => {
    const mine = sub({ status: "canceled", ended_at: T0 + DAY });
    const foreign = sub({ id: "sub_x", customer: "cus_attacker", created: T0 + 5 * DAY });
    expect(dataOf(sync(mine, [mine, foreign]))?.stripeSubscriptionId).toBe("sub_1");
  });

  it("a list Stripe had more of than was read: nothing changes", () => {
    expect(sync(sub(), [sub()], WS, false)).toMatchObject({ ok: false, level: "error" });
  });
});

describe("finding the workspace", () => {
  it("the named workspace must exist", () => {
    expect(sync(sub(), [sub()], null)).toMatchObject({ ok: false, level: "error" });
  });

  it("the event's subscription must be on the workspace's customer", () => {
    const foreign = sub({ customer: "cus_of_b" });
    expect(sync(foreign, [foreign])).toMatchObject({ ok: false, level: "error" });
  });

  it("a workspace with no customer is bound only through the checkout session that names it", () => {
    const noCustomer = { ...WS, stripeCustomerId: null, stripeSubscriptionId: null };
    const s = sub();
    expect(syncFromCustomerList(s, noCustomer, null, [s], ENV)).toMatchObject({ ok: false });
    for (const claim of [
      { workspaceId: "ws_other", customer: "cus_1", subscription: "sub_1" },
      { workspaceId: "ws_1", customer: "cus_other", subscription: "sub_1" },
      { workspaceId: "ws_1", customer: "cus_1", subscription: "sub_other" },
    ]) {
      expect(syncFromCustomerList(s, noCustomer, claim, [s], ENV)).toMatchObject({ ok: false });
    }
    const bound = syncFromCustomerList(s, noCustomer, { workspaceId: "ws_1", customer: "cus_1", subscription: "sub_1" }, [s], ENV);
    expect(dataOf(bound)).toMatchObject({ stripeCustomerId: "cus_1", plan: "growth" });
  });

  it("a claim never overrides a workspace that already has another customer", () => {
    const s = sub({ customer: "cus_other" });
    expect(syncFromCustomerList(s, WS, { workspaceId: "ws_1", customer: "cus_other", subscription: "sub_1" }, [s], ENV)).toMatchObject({
      ok: false,
      level: "error",
    });
  });

  it("an expanded customer object is accepted", () => {
    const s = sub({ customer: { id: "cus_1" } });
    expect(sync(s, [s]).ok).toBe(true);
  });

  it("an exempt-flag workspace is written, with a warning for the operator", () => {
    const result = sync(sub(), [sub()], { ...WS, billingExempt: true });
    expect(result.ok && result.warnings.length).toBe(1);
  });

  it("a workspace exempt only for having no plan and no trial is active once written", () => {
    const before = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };
    const data = dataOf(sync(sub(), [sub()]));
    expect(planState(before, new Date((PERIOD_START + DAY) * 1000))).toBe("exempt");
    expect(planState({ ...before, ...data }, new Date((PERIOD_START + DAY) * 1000))).toBe("active");
  });
});

describe("isLiveSubscriptionStatus (checkout and deletion)", () => {
  it("is false only for the two terminal statuses and anything unknown", () => {
    for (const status of ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"]) {
      expect(isLiveSubscriptionStatus(status), status).toBe(true);
    }
    for (const status of ["canceled", "incomplete_expired", "something_new", null, undefined]) {
      expect(isLiveSubscriptionStatus(status), String(status)).toBe(false);
    }
  });
});

// P1: a yearly price writes its plan; the period and the 7-day grace run from Stripe's yearly dates.
describe("a yearly subscription", () => {
  const YEARLY_ENV = { ...ENV, STRIPE_PRICE_GROWTH_YEARLY: "price_test_growth_year" };
  const YEAR_END = PERIOD_START + 365 * DAY;
  const yearly = (about: StripeSubscription) => syncFromCustomerList(about, WS, null, [about], YEARLY_ENV, true);

  it("writes its plan and the period end a year out", () => {
    const s = sub(priced("price_test_growth_year", PERIOD_START, YEAR_END));
    expect(dataOf(yearly(s))).toMatchObject({ plan: "growth", planStatus: "active", currentPeriodEnd: new Date(YEAR_END * 1000) });
  });

  it("past_due at renewal: posting stops 7 days after the paid year ended", () => {
    const s = sub({ status: "past_due", ...priced("price_test_growth_year", YEAR_END, YEAR_END + 365 * DAY) });
    const result = yearly(s);
    const data = result.ok ? result.data : null;
    expect(data?.currentPeriodEnd).toEqual(new Date(YEAR_END * 1000));
    expect(stateAt(data, YEAR_END + 6 * DAY)).toBe("active");
    expect(stateAt(data, YEAR_END + 7 * DAY + 60)).toBe("ended");
  });

  it("an unknown price still changes nothing", () => {
    const s = sub(priced("price_test_unknown_year"));
    expect(yearly(s).ok).toBe(false);
  });
});
