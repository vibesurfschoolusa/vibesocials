import { describe, expect, it } from "vitest";

import {
  duplicatePriceIds,
  offeredPlans,
  paymentsConfigured,
  planForPriceId,
  planPriceIds,
  priceIdForPlan,
  stripeReachable,
  stripeWebhookConfigured,
} from "./billing";

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

/** Fix round 1: talking to Stripe does not depend on BILLING_ENABLED. */
describe("stripeReachable and stripeWebhookConfigured", () => {
  it("Stripe is reachable whenever the secret key is set, billing on or off", () => {
    expect(stripeReachable({ STRIPE_SECRET_KEY: "sk_test_example" })).toBe(true);
    expect(stripeReachable({ ...FULL, BILLING_ENABLED: "" })).toBe(true);
    expect(stripeReachable(FULL)).toBe(true);
    expect(stripeReachable({ ...FULL, STRIPE_SECRET_KEY: " " })).toBe(false);
    expect(stripeReachable({})).toBe(false);
  });

  it("the webhook is configured whenever both secrets are set, billing on or off, prices or not", () => {
    expect(stripeWebhookConfigured({ STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_example" })).toBe(true);
    expect(stripeWebhookConfigured({ ...FULL, BILLING_ENABLED: "" })).toBe(true);
    expect(stripeWebhookConfigured({ ...FULL, STRIPE_WEBHOOK_SECRET: "" })).toBe(false);
    expect(stripeWebhookConfigured({ ...FULL, STRIPE_SECRET_KEY: undefined })).toBe(false);
  });
});

/** Fix round 7: several price ids per plan, the first used for new checkouts. */
describe("price id lists", () => {
  const LISTS = {
    ...FULL,
    STRIPE_PRICE_GROWTH: "price_example_growth_new, price_example_growth_old",
  };

  it("one id per plan: everything as before", () => {
    expect(planPriceIds(FULL)).toEqual({
      starter: ["price_example_starter"],
      growth: ["price_example_growth"],
      pro: ["price_example_pro"],
    });
    expect(priceIdForPlan("growth", FULL)).toBe("price_example_growth");
  });

  it("two ids for growth: either maps to growth; the first is the one checkout and the price display use", () => {
    expect(planForPriceId("price_example_growth_new", LISTS)).toBe("growth");
    expect(planForPriceId("price_example_growth_old", LISTS)).toBe("growth");
    expect(priceIdForPlan("growth", LISTS)).toBe("price_example_growth_new");
  });

  it("spaces and empty entries, a trailing comma included, are dropped", () => {
    const env = { ...FULL, STRIPE_PRICE_PRO: "  price_example_pro_a ,, price_example_pro_b , " };
    expect(planPriceIds(env).pro).toEqual(["price_example_pro_a", "price_example_pro_b"]);
    expect(priceIdForPlan("pro", env)).toBe("price_example_pro_a");
  });

  it("an id listed under two plans maps to no plan, is reported, and is never used for a checkout", () => {
    const env = {
      ...FULL,
      STRIPE_PRICE_STARTER: "price_example_shared, price_example_starter",
      STRIPE_PRICE_GROWTH: "price_example_growth, price_example_shared",
    };
    expect(planForPriceId("price_example_shared", env)).toBeNull();
    expect(duplicatePriceIds(env)).toEqual(["price_example_shared"]);
    expect(priceIdForPlan("starter", env)).toBe("price_example_starter");
    expect(duplicatePriceIds(FULL)).toEqual([]);
  });

  it("an id in no list maps to no plan", () => {
    expect(planForPriceId("price_example_other", LISTS)).toBeNull();
  });

  it("paymentsConfigured with lists: true when any plan has a usable id", () => {
    expect(paymentsConfigured({ ...FULL, STRIPE_PRICE_STARTER: "", STRIPE_PRICE_PRO: "", STRIPE_PRICE_GROWTH: "a, b" })).toBe(true);
    expect(paymentsConfigured({ ...FULL, STRIPE_PRICE_STARTER: " , ", STRIPE_PRICE_GROWTH: ",", STRIPE_PRICE_PRO: "" })).toBe(false);
    expect(offeredPlans(LISTS)).toEqual(["starter", "growth", "pro"]);
  });
});
