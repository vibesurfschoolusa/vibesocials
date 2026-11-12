import { describe, expect, it } from "vitest";

import { planChoiceView } from "./planChoiceButtons";
import { PLAN_RETURN_NOTICE, planReturnNotice, planSectionActions, planSectionLabel } from "./planSectionView";

/** 21b: which buttons Settings → Plan shows, and the line after returning from Stripe. */

const CONFIGURED = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_PRO: "price_example_pro",
};
const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const TRIAL = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: new Date(NOW.getTime() + 5 * DAY), currentPeriodEnd: null };
const ENDED = { ...TRIAL, trialEndsAt: new Date(NOW.getTime() - DAY) };
const ACTIVE = { ...TRIAL, plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) };
const CANCELED = { ...ACTIVE, planStatus: "canceled", currentPeriodEnd: new Date(NOW.getTime() - 20 * DAY) };

describe("planSectionActions", () => {
  it("no buttons at all without the Stripe secret key", () => {
    for (const env of [{}, { ...CONFIGURED, STRIPE_SECRET_KEY: "" }]) {
      for (const workspace of [TRIAL, ENDED, ACTIVE, { ...ACTIVE, stripeCustomerId: "cus_1" }]) {
        expect(planSectionActions("owner", workspace, NOW, env)).toBeNull();
      }
    }
  });

  it("billing off with the key set: no plan buttons, but Manage for a workspace with a plan or a customer", () => {
    const off = { ...CONFIGURED, BILLING_ENABLED: "" };
    expect(planSectionActions("owner", TRIAL, NOW, off)).toBeNull();
    expect(planSectionActions("owner", ACTIVE, NOW, off)).toEqual({ choose: [], manage: true });
    expect(planSectionActions("owner", { ...TRIAL, stripeCustomerId: "cus_1" }, NOW, off)).toEqual({ choose: [], manage: true });
  });

  it("no buttons for members", () => {
    expect(planSectionActions("member", TRIAL, NOW, CONFIGURED)).toBeNull();
  });

  it("in a trial or ended: a button per offered plan, nothing to manage", () => {
    expect(planSectionActions("owner", TRIAL, NOW, CONFIGURED)).toEqual({ choose: ["starter", "pro"], manage: false });
    expect(planSectionActions("owner", ENDED, NOW, CONFIGURED)).toEqual({ choose: ["starter", "pro"], manage: false });
  });

  it("with an active plan: manage only", () => {
    expect(planSectionActions("owner", ACTIVE, NOW, CONFIGURED)).toEqual({ choose: [], manage: true });
  });

  it("a plan that ended: choose again, and manage for the invoices", () => {
    expect(planSectionActions("owner", CANCELED, NOW, CONFIGURED)).toEqual({ choose: ["starter", "pro"], manage: true });
  });

  it("exempt with no plan and no customer: no buttons", () => {
    expect(planSectionActions("owner", { ...TRIAL, billingExempt: true }, NOW, CONFIGURED)).toBeNull();
    expect(planSectionActions("owner", { ...TRIAL, trialEndsAt: null }, NOW, CONFIGURED)).toBeNull();
  });

  it("a plan or a Stripe customer always gets Manage, whatever the state, exempt included (fix round 1)", () => {
    expect(planSectionActions("owner", { ...ACTIVE, billingExempt: true }, NOW, CONFIGURED)).toEqual({ choose: [], manage: true });
    expect(planSectionActions("owner", { ...TRIAL, trialEndsAt: null, stripeCustomerId: "cus_1" }, NOW, CONFIGURED)).toEqual({
      choose: [],
      manage: true,
    });
    expect(planSectionActions("owner", { ...TRIAL, stripeCustomerId: "cus_1" }, NOW, CONFIGURED)).toEqual({
      choose: ["starter", "pro"],
      manage: true,
    });
  });
});

describe("planReturnNotice", () => {
  it("after returning from Stripe, until the columns say the plan is active", () => {
    expect(PLAN_RETURN_NOTICE).toBe("Thanks. Your plan appears here within a minute.");
    expect(planReturnNotice("success", TRIAL, NOW)).toBe(PLAN_RETURN_NOTICE);
    expect(planReturnNotice("success", ENDED, NOW)).toBe(PLAN_RETURN_NOTICE);
    expect(planReturnNotice("success", ACTIVE, NOW)).toBeNull();
  });

  it("not without the return marker", () => {
    expect(planReturnNotice(undefined, TRIAL, NOW)).toBeNull();
    expect(planReturnNotice("other", TRIAL, NOW)).toBeNull();
  });
});

describe("planSectionLabel with planEndsAt (fix round 1)", () => {
  const ON = { BILLING_ENABLED: "true" };
  it("a plan set to cancel says when it ends, not that it renews", () => {
    const endsAt = new Date(NOW.getTime() + 20 * DAY);
    expect(planSectionLabel("owner", { ...ACTIVE, planEndsAt: endsAt }, NOW, ON)).toBe("Starter plan, ends on 30 December");
  });

  it("without planEndsAt it still renews", () => {
    expect(planSectionLabel("owner", { ...ACTIVE, planEndsAt: null }, NOW, ON)).toBe("Starter plan, renews 30 December");
  });
});

// P1: the plan buttons offer monthly and, where a yearly price exists, yearly (Q1: one interval at a time).
describe("planChoiceView: labels and bodies", () => {
  const MONTHLY = [
    { plan: "starter" as const, name: "Starter", price: "$19 a month" },
    { plan: "pro" as const, name: "Pro", price: null },
  ];

  it("with no yearly offers: today's buttons and bodies exactly", () => {
    expect(planChoiceView(MONTHLY, [], "month").buttons).toEqual([
      { key: "starter", label: "Choose Starter, $19 a month", body: { plan: "starter" } },
      { key: "pro", label: "Choose Pro", body: { plan: "pro" } },
    ]);
  });

  it("a yearly button per yearly offer, under Yearly", () => {
    const yearly = [
      { plan: "starter" as const, name: "Starter", price: "$190 a year", twoMonthsFree: true },
      { plan: "pro" as const, name: "Pro", price: null, twoMonthsFree: false },
    ];
    expect(planChoiceView(MONTHLY, yearly, "year").buttons).toEqual([
      { key: "starter-year", label: "Choose Starter, $190 a year", body: { plan: "starter", interval: "year" }, twoMonthsFree: true },
      { key: "pro-year", label: "Choose Pro yearly", body: { plan: "pro", interval: "year" }, twoMonthsFree: false },
    ]);
  });
});

// Q1: one Monthly / Yearly choice above one button per plan.
describe("planChoiceView", () => {
  const MONTHLY = [
    { plan: "starter" as const, name: "Starter", price: "$19 a month" },
    { plan: "growth" as const, name: "Growth", price: "$39 a month" },
    { plan: "pro" as const, name: "Pro", price: "$79 a month" },
  ];
  const YEARLY = [
    { plan: "starter" as const, name: "Starter", price: "$190 a year", twoMonthsFree: true },
    { plan: "growth" as const, name: "Growth", price: "$390 a year", twoMonthsFree: true },
    { plan: "pro" as const, name: "Pro", price: "$790 a year", twoMonthsFree: true },
  ];

  it("with no yearly offers: no switch and today's three monthly buttons, whatever is asked", () => {
    for (const asked of ["month", "year"] as const) {
      expect(planChoiceView(MONTHLY, [], asked)).toEqual({
        showSwitch: false,
        interval: "month",
        buttons: [
          { key: "starter", label: "Choose Starter, $19 a month", body: { plan: "starter" } },
          { key: "growth", label: "Choose Growth, $39 a month", body: { plan: "growth" } },
          { key: "pro", label: "Choose Pro, $79 a month", body: { plan: "pro" } },
        ],
      });
    }
  });

  it("with all six prices: the switch, and three buttons for the interval chosen, each sending it", () => {
    const month = planChoiceView(MONTHLY, YEARLY, "month");
    expect(month.showSwitch).toBe(true);
    expect(month.buttons.map((button) => button.body)).toEqual([{ plan: "starter" }, { plan: "growth" }, { plan: "pro" }]);

    const year = planChoiceView(MONTHLY, YEARLY, "year");
    expect(year).toEqual({
      showSwitch: true,
      interval: "year",
      buttons: [
        { key: "starter-year", label: "Choose Starter, $190 a year", body: { plan: "starter", interval: "year" }, twoMonthsFree: true },
        { key: "growth-year", label: "Choose Growth, $390 a year", body: { plan: "growth", interval: "year" }, twoMonthsFree: true },
        { key: "pro-year", label: "Choose Pro, $790 a year", body: { plan: "pro", interval: "year" }, twoMonthsFree: true },
      ],
    });
  });

  it("yearly for some plans only: Yearly lists only those, Monthly all", () => {
    const some = [YEARLY[1]];
    expect(planChoiceView(MONTHLY, some, "month").buttons.map((button) => button.key)).toEqual(["starter", "growth", "pro"]);
    expect(planChoiceView(MONTHLY, some, "year").buttons.map((button) => button.key)).toEqual(["growth-year"]);
  });

  it("the saving line only where the pricing page shows it: a price and twoMonthsFree", () => {
    const year = planChoiceView(
      MONTHLY,
      [
        { ...YEARLY[0], twoMonthsFree: false },
        { ...YEARLY[1], price: null },
        YEARLY[2],
      ],
      "year",
    );
    expect(year.buttons.map((button) => button.twoMonthsFree)).toEqual([false, false, true]);
    expect(year.buttons[1].label).toBe("Choose Growth yearly");
  });

  it("only yearly prices: no switch, the yearly buttons", () => {
    expect(planChoiceView([], YEARLY, "month")).toMatchObject({ showSwitch: false, interval: "year" });
    expect(planChoiceView([], YEARLY, "month").buttons).toHaveLength(3);
  });
});
