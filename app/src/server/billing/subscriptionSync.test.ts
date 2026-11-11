import { describe, expect, it } from "vitest";

import { planState } from "@/lib/billing";

import type { StripeSubscription } from "./stripeApi";
import { isLiveSubscriptionStatus, syncFromCustomerList, type SyncWorkspace } from "./subscriptionSync";

/**
 * Fix round 3: the workspace is synced from the customer's whole list of
 * subscriptions, not from the one an event is about. The tests read as a
 * table: one subscription through its life, then two at once.
 */

const ENV = {
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

const T0 = 1798000000;
const PERIOD_END = 1800000000;
const DAY = 86400;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: T0,
    metadata: { workspaceId: "ws_1" },
    trial_end: null,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_example_growth" }, current_period_start: PERIOD_END - 30 * DAY, current_period_end: PERIOD_END }] },
    ...overrides,
  };
}

const WS: SyncWorkspace = { id: "ws_1", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", billingExempt: false };

/** The event is about `about`; Stripe's list for the customer is `list`. */
const sync = (about: StripeSubscription, list: StripeSubscription[], workspace: SyncWorkspace | null = WS, eventAt: Date | null = null) =>
  syncFromCustomerList(about, workspace, null, list, ENV, eventAt);

const dataOf = (result: ReturnType<typeof sync>) => (result.ok ? result.data : null);
const stateAt = (data: Record<string, unknown> | null, seconds: number) =>
  planState({ billingExempt: false, ...(data ?? {}) }, new Date(seconds * 1000));

describe("one subscription through its life", () => {
  it("created: plan, status, period end, no plan end, the subscription id", () => {
    const s = sub({ status: "active" });
    expect(dataOf(sync(s, [s]))).toEqual({
      plan: "growth",
      planStatus: "active",
      currentPeriodEnd: new Date(PERIOD_END * 1000),
      planEndsAt: null,
      stripeSubscriptionId: "sub_1",
    });
  });

  it("created in a trial: trialing with its trial end", () => {
    const s = sub({ status: "trialing", trial_end: T0 + 14 * DAY });
    expect(dataOf(sync(s, [s]))).toMatchObject({ planStatus: "trialing", trialEndsAt: new Date((T0 + 14 * DAY) * 1000) });
  });

  it("renewed: the new period end", () => {
    const s = sub({
      items: { data: [{ price: { id: "price_example_growth" }, current_period_start: PERIOD_END, current_period_end: PERIOD_END + 30 * DAY }] },
    });
    expect(dataOf(sync(s, [s]))?.currentPeriodEnd).toEqual(new Date((PERIOD_END + 30 * DAY) * 1000));
  });

  it("past_due after a failed renewal: the date is the renewal, so posting stops 7 days after it", () => {
    const s = sub({
      status: "past_due",
      items: { data: [{ price: { id: "price_example_growth" }, current_period_start: PERIOD_END, current_period_end: PERIOD_END + 30 * DAY }] },
    });
    const data = dataOf(sync(s, [s]));
    expect(data?.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
    expect(stateAt(data, PERIOD_END + 6 * DAY)).toBe("active");
    expect(stateAt(data, PERIOD_END + 7 * DAY + 60)).toBe("ended");
  });

  it("past_due with no period start falls back to the period end", () => {
    const s = sub({ status: "past_due", items: { data: [{ price: { id: "price_example_growth" }, current_period_end: PERIOD_END }] } });
    expect(dataOf(sync(s, [s]))?.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  it("paid again: active with the new period end", () => {
    const s = sub({
      status: "active",
      items: { data: [{ price: { id: "price_example_growth" }, current_period_start: PERIOD_END, current_period_end: PERIOD_END + 30 * DAY }] },
    });
    const data = dataOf(sync(s, [s]));
    expect(data).toMatchObject({ planStatus: "active", currentPeriodEnd: new Date((PERIOD_END + 30 * DAY) * 1000) });
    expect(stateAt(data, PERIOD_END + 20 * DAY)).toBe("active");
  });

  it("cancelled at period end: still active, with the plan end", () => {
    const s = sub({ cancel_at_period_end: true });
    expect(dataOf(sync(s, [s]))).toMatchObject({ planStatus: "active", planEndsAt: new Date(PERIOD_END * 1000) });
  });

  it("a set cancel date is the plan end; undoing the cancellation clears it", () => {
    const s = sub({ cancel_at: PERIOD_END - DAY });
    expect(dataOf(sync(s, [s]))?.planEndsAt).toEqual(new Date((PERIOD_END - DAY) * 1000));
    const undone = sub({ cancel_at: null, cancel_at_period_end: false });
    expect(dataOf(sync(undone, [undone]))?.planEndsAt).toBeNull();
  });

  it("cancelled now: canceled, the plan kept, so the block says the plan has ended", () => {
    const s = sub({ status: "canceled", ended_at: T0 + 40 * DAY, canceled_at: T0 + 40 * DAY });
    const data = dataOf(sync(s, [s]));
    expect(data).toMatchObject({ plan: "growth", planStatus: "canceled", stripeSubscriptionId: "sub_1" });
    expect(stateAt(data, PERIOD_END + 10 * DAY)).toBe("ended");
  });

  it("every status that is not active, trialing or past_due ends the plan as canceled", () => {
    for (const status of ["incomplete", "incomplete_expired", "canceled", "unpaid", "paused", "something_new"]) {
      const s = sub({ status });
      expect(dataOf(sync(s, [s]))?.planStatus, status).toBe("canceled");
    }
    for (const status of ["active", "trialing", "past_due"]) {
      const s = sub({ status });
      expect(dataOf(sync(s, [s]))?.planStatus, status).toBe(status);
    }
  });
});

describe("two subscriptions at once", () => {
  const older = (overrides: Partial<StripeSubscription> = {}) => sub({ id: "sub_1", created: T0, ...overrides });
  const newer = (overrides: Partial<StripeSubscription> = {}) =>
    sub({
      id: "sub_2",
      created: T0 + DAY,
      items: { data: [{ price: { id: "price_example_pro" }, current_period_end: PERIOD_END + DAY }] },
      ...overrides,
    });

  it("two live: the most recently created one is used, and both are reported", () => {
    const result = sync(older(), [older(), newer()]);
    expect(dataOf(result)).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "pro", planStatus: "active" });
    expect(result.ok && result.liveCandidateIds).toEqual(["sub_2", "sub_1"]);
  });

  it("two live, the stored one is cancelled: the workspace is on the other, active", () => {
    const list = [older({ status: "canceled", ended_at: T0 + 2 * DAY }), newer()];
    expect(dataOf(sync(list[0], list))).toMatchObject({ stripeSubscriptionId: "sub_2", planStatus: "active" });
    // Stored the older one, cancelled the newer: the older is the only live one left.
    const list2 = [older(), newer({ status: "canceled", ended_at: T0 + 2 * DAY })];
    expect(dataOf(sync(list2[1], list2, { ...WS, stripeSubscriptionId: "sub_2" }))).toMatchObject({
      stripeSubscriptionId: "sub_1",
      planStatus: "active",
    });
  });

  it("two live, the other is cancelled: the workspace stays on the stored one when it is the newest live one", () => {
    const list = [older({ status: "canceled", ended_at: T0 + 2 * DAY }), newer()];
    expect(dataOf(sync(list[0], list, { ...WS, stripeSubscriptionId: "sub_2" }))).toMatchObject({
      stripeSubscriptionId: "sub_2",
      planStatus: "active",
    });
  });

  it("two live, the other is cancelled, a third live one is newer than the stored: it moves to the newest live one", () => {
    const third = sub({ id: "sub_3", created: T0 + 2 * DAY });
    const list = [older(), newer({ status: "canceled", ended_at: T0 + 3 * DAY }), third];
    expect(dataOf(sync(list[1], list))).toMatchObject({ stripeSubscriptionId: "sub_3" });
  });

  it("both cancelled close together, whichever event is handled: canceled, on the one that ended last", () => {
    const list = [
      older({ status: "canceled", ended_at: T0 + 5 * DAY }),
      newer({ status: "canceled", ended_at: T0 + 5 * DAY + 2 }),
    ];
    for (const about of list) {
      expect(dataOf(sync(about, list)), about.id).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_2", plan: "pro" });
    }
  });

  it("an ended one is ranked by ended_at, then canceled_at, then created", () => {
    const a = older({ status: "canceled", ended_at: null, canceled_at: T0 + 9 * DAY });
    const b = newer({ status: "canceled", ended_at: T0 + 8 * DAY });
    expect(dataOf(sync(a, [a, b]))?.stripeSubscriptionId).toBe("sub_1");
    const c = older({ status: "incomplete_expired", ended_at: null, canceled_at: null });
    const d = newer({ status: "incomplete_expired", ended_at: null, canceled_at: null });
    expect(dataOf(sync(c, [c, d]))?.stripeSubscriptionId).toBe("sub_2");
  });
});

describe("prices that are not configured", () => {
  it("the only live candidate has an unknown price: not chosen; with an ended candidate the workspace is canceled", () => {
    const live = sub({ id: "sub_2", created: T0 + DAY, items: { data: [{ price: { id: "price_example_other" }, current_period_end: PERIOD_END }] } });
    const ended = sub({ id: "sub_1", status: "canceled", ended_at: T0 + DAY });
    const result = sync(live, [live, ended]);
    expect(dataOf(result)).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_1", plan: "growth" });
    expect(result.unconfigured).toEqual([{ subscriptionId: "sub_2", priceId: "price_example_other" }]);
  });

  it("the only candidate is live with an unknown price: nothing is written, and the price is reported", () => {
    const live = sub({ items: { data: [{ price: { id: "price_example_other" }, current_period_end: PERIOD_END }] } });
    const result = sync(live, [live]);
    expect(result).toMatchObject({ ok: false, level: "error" });
    expect(result.unconfigured).toEqual([{ subscriptionId: "sub_1", priceId: "price_example_other" }]);
  });

  it("an ended effective subscription with an unknown price writes canceled and keeps the stored plan", () => {
    const ended = sub({ status: "canceled", items: { data: [{ price: { id: "price_example_old" }, current_period_end: PERIOD_END }] } });
    const data = dataOf(sync(ended, [ended]));
    expect(data).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_1" });
    expect(data && "plan" in data).toBe(false);
  });
});

describe("who is a candidate", () => {
  it("a live subscription of the customer naming a different workspace, or none, is never chosen", () => {
    const mine = sub({ status: "canceled", ended_at: T0 + DAY });
    const other = sub({ id: "sub_9", created: T0 + 5 * DAY, metadata: { workspaceId: "ws_2" } });
    const bare = sub({ id: "sub_8", created: T0 + 6 * DAY, metadata: {} });
    expect(dataOf(sync(mine, [mine, other, bare]))).toMatchObject({ planStatus: "canceled", stripeSubscriptionId: "sub_1" });
  });

  it("a subscription in the list on another customer is never chosen", () => {
    const mine = sub({ status: "canceled", ended_at: T0 + DAY });
    const foreign = sub({ id: "sub_x", customer: "cus_attacker", created: T0 + 5 * DAY });
    expect(dataOf(sync(mine, [mine, foreign]))?.stripeSubscriptionId).toBe("sub_1");
  });

  it("no candidates at all: nothing is written", () => {
    expect(sync(sub(), [])).toMatchObject({ ok: false });
  });
});

describe("finding the workspace (unchanged)", () => {
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
    expect(planState(before, new Date((PERIOD_END - DAY) * 1000))).toBe("exempt");
    expect(planState({ ...before, ...data }, new Date((PERIOD_END - DAY) * 1000))).toBe("active");
  });
});

describe("event order (unchanged)", () => {
  const AT = new Date(1799000000 * 1000);

  it("stores the event's time, and refuses one older than the stored time", () => {
    expect(dataOf(sync(sub(), [sub()], WS, AT))?.stripeLastEventAt).toEqual(AT);
    expect(sync(sub(), [sub()], { ...WS, stripeLastEventAt: AT }, new Date(AT.getTime() - 1000))).toMatchObject({
      ok: false,
      level: "info",
    });
  });

  it("the same time is not older", () => {
    expect(sync(sub(), [sub()], { ...WS, stripeLastEventAt: AT }, AT).ok).toBe(true);
  });

  it("an event with no time does not overwrite a timed write", () => {
    expect(sync(sub(), [sub()], { ...WS, stripeLastEventAt: AT }, null)).toMatchObject({ ok: false });
    expect(sync(sub(), [sub()], WS, null).ok).toBe(true);
  });
});

describe("isLiveSubscriptionStatus", () => {
  it("is false only for the two terminal statuses and anything unknown", () => {
    for (const status of ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"]) {
      expect(isLiveSubscriptionStatus(status), status).toBe(true);
    }
    for (const status of ["canceled", "incomplete_expired", "something_new", null, undefined]) {
      expect(isLiveSubscriptionStatus(status), String(status)).toBe(false);
    }
  });
});
