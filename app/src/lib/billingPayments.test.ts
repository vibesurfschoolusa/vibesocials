import { describe, expect, it } from "vitest";

import { offeredPlans, paymentsConfigured, planForPriceId, priceIdForPlan } from "./billing";

const FULL = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
  STRIPE_PRICE_PRO: "price_example_pro",
};

describe("paymentsConfigured", () => {
  it("is true with billing on, both secrets and every price", () => {
    expect(paymentsConfigured(FULL)).toBe(true);
  });

  it("is true with only one price", () => {
    expect(
      paymentsConfigured({ ...FULL, STRIPE_PRICE_GROWTH: undefined, STRIPE_PRICE_PRO: "" }),
    ).toBe(true);
  });

  it("is false with billing off, whatever else is set", () => {
    expect(paymentsConfigured({ ...FULL, BILLING_ENABLED: undefined })).toBe(false);
    expect(paymentsConfigured({ ...FULL, BILLING_ENABLED: "false" })).toBe(false);
  });

  it("is false without either secret", () => {
    expect(paymentsConfigured({ ...FULL, STRIPE_SECRET_KEY: undefined })).toBe(false);
    expect(paymentsConfigured({ ...FULL, STRIPE_SECRET_KEY: "  " })).toBe(false);
    expect(paymentsConfigured({ ...FULL, STRIPE_WEBHOOK_SECRET: "" })).toBe(false);
  });

  it("is false with no price at all", () => {
    expect(
      paymentsConfigured({ ...FULL, STRIPE_PRICE_STARTER: "", STRIPE_PRICE_GROWTH: undefined, STRIPE_PRICE_PRO: " " }),
    ).toBe(false);
  });

  it("is false with nothing set", () => {
    expect(paymentsConfigured({})).toBe(false);
  });
});

describe("prices and plans", () => {
  it("offers only the plans that have a price, in plan order", () => {
    expect(offeredPlans(FULL)).toEqual(["starter", "growth", "pro"]);
    expect(offeredPlans({ ...FULL, STRIPE_PRICE_STARTER: "" })).toEqual(["growth", "pro"]);
  });

  it("maps a plan to its price and a price back to its plan", () => {
    expect(priceIdForPlan("growth", FULL)).toBe("price_example_growth");
    expect(priceIdForPlan("growth", { ...FULL, STRIPE_PRICE_GROWTH: undefined })).toBeNull();
    expect(planForPriceId("price_example_pro", FULL)).toBe("pro");
  });

  it("an unknown or empty price is no plan", () => {
    expect(planForPriceId("price_example_other", FULL)).toBeNull();
    expect(planForPriceId("", { ...FULL, STRIPE_PRICE_STARTER: "" })).toBeNull();
    expect(planForPriceId(null, FULL)).toBeNull();
  });

  it("trims the values", () => {
    expect(priceIdForPlan("pro", { ...FULL, STRIPE_PRICE_PRO: " price_example_pro " })).toBe("price_example_pro");
    expect(planForPriceId("price_example_pro", { ...FULL, STRIPE_PRICE_PRO: " price_example_pro " })).toBe("pro");
  });
});
