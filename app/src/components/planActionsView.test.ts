import { describe, expect, it } from "vitest";

import { PLAN_RETURN_NOTICE, planReturnNotice, planSectionActions } from "./planSectionView";

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
  it("no buttons with payments not configured", () => {
    for (const env of [{}, { ...CONFIGURED, BILLING_ENABLED: "" }, { ...CONFIGURED, STRIPE_SECRET_KEY: "" }]) {
      for (const workspace of [TRIAL, ENDED, ACTIVE]) {
        expect(planSectionActions("owner", workspace, NOW, env)).toBeNull();
      }
    }
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

  it("exempt: no buttons", () => {
    expect(planSectionActions("owner", { ...TRIAL, billingExempt: true }, NOW, CONFIGURED)).toBeNull();
    expect(planSectionActions("owner", { ...TRIAL, trialEndsAt: null }, NOW, CONFIGURED)).toBeNull();
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
