import { describe, expect, it } from "vitest";

import { planGrowthAddsShown, planNoPlanYet, planPersonalPostNote, planSectionActions, planSectionLabel } from "./planSectionView";

/** 21a: what Settings → Plan says, and when it is there at all. */

const ON = { BILLING_ENABLED: "true" };
const NOW = new Date("2026-12-10T12:00:00Z");
const NEW = {
  billingExempt: false,
  plan: null,
  planStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
};

// R7-new-customer M1: checkout already lets such a workspace buy a plan.
describe("planSectionActions for a workspace made while billing was off", () => {
  const CONFIGURED = {
    BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_PRICE_STARTER: "price_example_starter",
    STRIPE_PRICE_PRO: "price_example_pro",
  };

  it("offers the plans to one with no plan and no trial", () => {
    expect(planSectionActions("owner", NEW, NOW, CONFIGURED)).toEqual({ choose: ["starter", "pro"], manage: false });
  });

  it("offers none to one exempt by its flag, or to a member", () => {
    expect(planSectionActions("owner", { ...NEW, billingExempt: true }, NOW, CONFIGURED)).toBeNull();
    expect(planSectionActions("member", NEW, NOW, CONFIGURED)).toBeNull();
  });
});

describe("planSectionLabel", () => {
  it("is absent with billing off, whatever the workspace", () => {
    for (const env of [{}, { BILLING_ENABLED: "TRUE" }, { ...ON, BILLING_ENABLED: "false" }]) {
      expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") }, NOW, env)).toBeNull();
      expect(planSectionLabel("owner", { billingExempt: true }, NOW, env)).toBeNull();
    }
  });

  it("is absent for members", () => {
    expect(planSectionLabel("member", { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") }, NOW, ON)).toBeNull();
    expect(planSectionLabel("member", { ...NEW, billingExempt: true }, NOW, ON)).toBeNull();
  });

  // R7-pages L5: the dates read like every other Settings date (displayDate.ts).
  it("a trial", () => {
    expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-24T12:00:00Z") }, NOW, ON)).toBe(
      "Free trial until December 24, 2026",
    );
  });

  it("an active plan, with and without a renewal date", () => {
    const growth = { ...NEW, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2027-01-03T12:00:00Z") };
    expect(planSectionLabel("owner", growth, NOW, ON)).toBe("Growth plan, renews January 3, 2027");
    expect(planSectionLabel("owner", { ...growth, currentPeriodEnd: null }, NOW, ON)).toBe("Growth plan");
    expect(planSectionLabel("owner", { ...growth, plan: "custom" }, NOW, ON)).toBe("Your plan, renews January 3, 2027");
  });

  // Live billing test 2026-11-13: a plan chosen during the free trial is "trialing"
  // at Stripe until the trial ends, and nothing has been charged yet, so its
  // period end is the first payment, not a renewal.
  it("a plan still in Stripe's trial: the period end is the first payment", () => {
    const trialing = { ...NEW, plan: "starter", planStatus: "trialing", currentPeriodEnd: new Date("2026-12-24T12:00:00Z") };
    expect(planSectionLabel("owner", trialing, NOW, ON)).toBe("Starter plan, first payment on December 24, 2026");
    expect(planSectionLabel("owner", { ...trialing, plan: "custom" }, NOW, ON)).toBe(
      "Your plan, first payment on December 24, 2026",
    );
    // Cancelled during the trial: it ends then and is never charged.
    expect(planSectionLabel("owner", { ...trialing, planEndsAt: new Date("2026-12-24T12:00:00Z") }, NOW, ON)).toBe(
      "Starter plan, ends on December 24, 2026",
    );
    expect(planSectionLabel("owner", { ...trialing, currentPeriodEnd: null }, NOW, ON)).toBe("Starter plan");
    // Once Stripe has charged it, the same plan renews as before.
    expect(planSectionLabel("owner", { ...trialing, planStatus: "active" }, NOW, ON)).toBe(
      "Starter plan, renews December 24, 2026",
    );
  });

  it("a plan whose payment failed, still in its week", () => {
    const pastDue = { ...NEW, plan: "pro", planStatus: "past_due", currentPeriodEnd: new Date("2026-12-08T12:00:00Z") };
    expect(planSectionLabel("owner", pastDue, NOW, ON)).toBe(
      "Pro plan. The last payment did not go through; posting stops on December 15, 2026.",
    );
  });

  // R7-new-customer M1: only the flag means no plan is needed. A workspace
  // made while billing was off has the free limits until it has a plan.
  it("exempt by its flag needs no plan; one that never had a trial or a plan is told the free limits apply", () => {
    expect(planSectionLabel("owner", { ...NEW, billingExempt: true }, NOW, ON)).toBe("No plan is needed for this workspace.");
    expect(planSectionLabel("owner", NEW, NOW, ON)).toBe(
      "This workspace has no plan yet. The free limits apply until it has one.",
    );
  });

  it("ended: a plan, or a trial", () => {
    expect(planSectionLabel("owner", { ...NEW, plan: "starter", planStatus: "canceled" }, NOW, ON)).toBe(
      "Your plan has ended",
    );
    expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-09T00:00:00Z") }, NOW, ON)).toBe(
      "Your free trial has ended",
    );
  });
});

// P1: on an active Starter plan, Settings says what Growth adds.
describe("planGrowthAddsShown", () => {
  const ON = { BILLING_ENABLED: "true" };
  const NOW = new Date("2026-12-10T12:00:00Z");
  const LATER = new Date("2026-12-30T00:00:00Z");

  it("is true for an owner on an active Starter plan with billing on", () => {
    expect(planGrowthAddsShown("owner", { plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(true);
  });

  it("is false on Growth, in a trial, exempt, ended, for a member and with billing off", () => {
    const starter = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };
    expect(planGrowthAddsShown("owner", { ...starter, plan: "growth" }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { trialEndsAt: LATER }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { ...starter, billingExempt: true }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { ...starter, planStatus: "canceled", currentPeriodEnd: NOW }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("member", starter, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", starter, NOW, {})).toBe(false);
  });
});

// P1 fix round 2: the line follows planIncludes, not the plan's name.
describe("planGrowthAddsShown asks the rule", () => {
  const ON = { BILLING_ENABLED: "true" };
  const NOW = new Date("2026-12-10T12:00:00Z");
  const LATER = new Date("2026-12-30T00:00:00Z");

  it("shows the line for any active plan without the Growth features, an unknown one too", () => {
    expect(planGrowthAddsShown("owner", { plan: "enterprise", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(true);
  });

  it("not on Pro", () => {
    expect(planGrowthAddsShown("owner", { plan: "pro", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(false);
  });
});

// R8-new-customer L4 (lead's follow-up): a real flag for "no plan and no trial", not a label match.
describe("planNoPlanYet", () => {
  it("true for an owner's workspace with no plan, no trial and no exempt flag", () => {
    expect(planNoPlanYet("owner", NEW, NOW)).toBe(true);
  });

  it("false on a trial, on a plan, for an exempt one, or for a member", () => {
    expect(planNoPlanYet("owner", { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") }, NOW)).toBe(false);
    expect(planNoPlanYet("owner", { ...NEW, plan: "starter", planStatus: "active" }, NOW)).toBe(false);
    expect(planNoPlanYet("owner", { ...NEW, billingExempt: true }, NOW)).toBe(false);
    expect(planNoPlanYet("member", NEW, NOW)).toBe(false);
  });
});

// R8-new-customer L1 (lead's follow-up): the viewer's own number, only where the per-person limit applies.
describe("planPersonalPostNote", () => {
  const TRIAL = { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") };
  const CONFIRMED = { emailVerifiedAt: new Date("2026-11-01T09:00:00Z"), createdAt: new Date("2026-11-01T08:00:00Z") };

  it("free (a trial), confirmed and past the first day: 15", () => {
    expect(planPersonalPostNote(TRIAL, CONFIRMED, false, NOW, ON)).toEqual({ limit: 15, reduced: null });
  });

  it("unconfirmed: 5, with its reason", () => {
    expect(planPersonalPostNote(TRIAL, { ...CONFIRMED, emailVerifiedAt: null }, false, NOW, ON)).toEqual({
      limit: 5,
      reduced: "unconfirmed",
    });
  });

  it("the account's first UTC day: 5, with its reason", () => {
    const today = { emailVerifiedAt: new Date("2026-12-10T08:30:00Z"), createdAt: new Date("2026-12-10T08:00:00Z") };
    expect(planPersonalPostNote(NEW, today, false, NOW, ON)).toEqual({ limit: 5, reduced: "first_day" });
  });

  // R8 review: with billing off every workspace counts toward its owners' number.
  it("billing off: the note shows, even for a workspace with a plan", () => {
    expect(planPersonalPostNote(TRIAL, CONFIRMED, false, NOW, {})).toEqual({ limit: 15, reduced: null });
    expect(planPersonalPostNote({ ...NEW, plan: "starter", planStatus: "active" }, CONFIRMED, false, NOW, {})).toEqual({
      limit: 15,
      reduced: null,
    });
    expect(planPersonalPostNote(TRIAL, CONFIRMED, true, NOW, {})).toBeNull();
  });

  it("a paying workspace, an exempt one or an operator's: no note", () => {
    const paid = { ...NEW, plan: "starter", planStatus: "active", planPaidAt: new Date("2026-12-01T01:00:00Z") };
    expect(planPersonalPostNote(paid, CONFIRMED, false, NOW, ON)).toBeNull();
    expect(planPersonalPostNote({ ...NEW, billingExempt: true }, CONFIRMED, false, NOW, ON)).toBeNull();
    expect(planPersonalPostNote(TRIAL, CONFIRMED, true, NOW, ON)).toBeNull();
  });

  // R10-pages M1: a plan not yet paid for (in its card trial, or active before
  // the first invoice is paid) counts toward the owner's number, and Plan says so.
  it("a plan in its card trial, or active with no paid invoice: the note, and until the first payment", () => {
    const end = new Date("2026-12-24T00:00:00Z");
    const trialing = { ...NEW, plan: "pro", planStatus: "trialing", trialEndsAt: end, currentPeriodEnd: end };
    const activeUnpaid = { ...trialing, planStatus: "active", trialEndsAt: new Date("2026-12-10T00:00:00Z") };
    for (const workspace of [trialing, activeUnpaid]) {
      expect(planPersonalPostNote(workspace, CONFIRMED, false, NOW, ON), workspace.planStatus).toEqual({
        limit: 15,
        reduced: null,
        untilFirstPayment: true,
      });
    }
    // A new account's own number.
    expect(planPersonalPostNote(trialing, { ...CONFIRMED, emailVerifiedAt: null }, false, NOW, ON)).toEqual({
      limit: 5,
      reduced: "unconfirmed",
      untilFirstPayment: true,
    });
    // Not a plan (a trial with none), billing off, or an operator's: no such line.
    expect(planPersonalPostNote(TRIAL, CONFIRMED, false, NOW, ON)).not.toHaveProperty("untilFirstPayment");
    expect(planPersonalPostNote(activeUnpaid, CONFIRMED, false, NOW, {})).toEqual({ limit: 15, reduced: null });
    expect(planPersonalPostNote(activeUnpaid, CONFIRMED, true, NOW, ON)).toBeNull();
  });
});
