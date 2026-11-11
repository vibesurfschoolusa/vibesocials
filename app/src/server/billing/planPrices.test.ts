import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ retrievePrice: vi.fn(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  retrievePrice: m.retrievePrice,
}));

import { StripeApiError } from "./stripeApi";
import { formatPriceLabel, getPlanOffers, resetPlanPriceCache } from "./planPrices";

const ENV = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  STRIPE_PRICE_GROWTH: "price_example_growth",
};
const NOW = Date.UTC(2026, 10, 10, 12);

const price = (id: string, unit_amount: number) => ({
  id,
  unit_amount,
  currency: "usd",
  recurring: { interval: "month", interval_count: 1 },
});

beforeEach(() => {
  resetPlanPriceCache();
  m.retrievePrice.mockReset();
  m.retrievePrice.mockImplementation(async (id: string) =>
    price(id, id === "price_example_starter" ? 9900 : 16950),
  );
});

describe("formatPriceLabel", () => {
  it("whole dollars without cents, otherwise with", () => {
    expect(formatPriceLabel(price("p", 9900))).toBe("$99 a month");
    expect(formatPriceLabel(price("p", 16950))).toBe("$169.50 a month");
  });

  it("other intervals and currencies", () => {
    expect(formatPriceLabel({ ...price("p", 99000), recurring: { interval: "year", interval_count: 1 } })).toBe("$990 a year");
    expect(formatPriceLabel({ ...price("p", 9900), recurring: { interval: "month", interval_count: 3 } })).toBe("$99 every 3 months");
    expect(formatPriceLabel({ ...price("p", 9900), currency: "eur" })).toBe("€99 a month");
    expect(formatPriceLabel({ ...price("p", 9900), currency: "jpy" })).toBe("¥9,900 a month");
  });

  it("no amount: no label", () => {
    expect(formatPriceLabel({ ...price("p", 0), unit_amount: null })).toBeNull();
  });
});

describe("getPlanOffers", () => {
  it("reads each offered plan's price from Stripe", async () => {
    expect(await getPlanOffers(["starter", "growth"], ENV, NOW)).toEqual([
      { plan: "starter", name: "Starter", price: "$99 a month" },
      { plan: "growth", name: "Growth", price: "$169.50 a month" },
    ]);
  });

  it("keeps them for an hour", async () => {
    await getPlanOffers(["starter"], ENV, NOW);
    await getPlanOffers(["starter"], ENV, NOW + 59 * 60 * 1000);
    expect(m.retrievePrice).toHaveBeenCalledTimes(1);
    await getPlanOffers(["starter"], ENV, NOW + 61 * 60 * 1000);
    expect(m.retrievePrice).toHaveBeenCalledTimes(2);
  });

  it("when Stripe cannot be reached, keeps the plan names without prices", async () => {
    m.retrievePrice.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    expect(await getPlanOffers(["starter", "growth"], ENV, NOW)).toEqual([
      { plan: "starter", name: "Starter", price: null },
      { plan: "growth", name: "Growth", price: null },
    ]);
  });

  it("a failure is retried after a few minutes, not on every page load", async () => {
    m.retrievePrice.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    await getPlanOffers(["starter"], ENV, NOW);
    await getPlanOffers(["starter"], ENV, NOW + 60 * 1000);
    expect(m.retrievePrice).toHaveBeenCalledTimes(1);
    await getPlanOffers(["starter"], ENV, NOW + 6 * 60 * 1000);
    expect(m.retrievePrice).toHaveBeenCalledTimes(2);
  });

  it("a plan with no price is not offered", async () => {
    expect(await getPlanOffers(["pro"], ENV, NOW)).toEqual([]);
    expect(m.retrievePrice).not.toHaveBeenCalled();
  });
});
