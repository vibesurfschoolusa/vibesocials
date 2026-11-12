import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ retrievePrice: vi.fn(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  retrievePrice: m.retrievePrice,
}));

import { StripeApiError } from "./stripeApi";
import { formatPriceLabel, getPlanOffers, getYearlyPlanOffers, resetPlanPriceCache, yearlySavingTrue } from "./planPrices";

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

  it("reads the first id of a plan's list", async () => {
    await getPlanOffers(["growth"], { ...ENV, STRIPE_PRICE_GROWTH: "price_example_growth_new, price_example_growth" }, NOW);
    expect(m.retrievePrice).toHaveBeenCalledWith("price_example_growth_new", expect.anything());
  });

  it("an id listed under two plans is logged once for the render", async () => {
    await getPlanOffers(["starter", "growth"], { ...ENV, STRIPE_PRICE_STARTER: "price_example_starter, price_example_growth" }, NOW);
    expect(m.logger.error.mock.calls.filter(([message]) => String(message).includes("two plans"))).toHaveLength(1);
  });

  it("a plan with no price is not offered", async () => {
    expect(await getPlanOffers(["pro"], ENV, NOW)).toEqual([]);
    expect(m.retrievePrice).not.toHaveBeenCalled();
  });
});

// P1: yearly prices and whether "two months free" is true.
describe("yearlySavingTrue", () => {
  const month = (unit_amount: number, currency = "usd") => ({ unit_amount, currency, recurring: { interval: "month", interval_count: 1 } });
  const year = (unit_amount: number, currency = "usd") => ({ unit_amount, currency, recurring: { interval: "year", interval_count: 1 } });

  it("is true when a year costs at most ten months", () => {
    expect(yearlySavingTrue(month(1900), year(19000))).toBe(true);
    expect(yearlySavingTrue(month(1900), year(15000))).toBe(true);
  });

  it("is false when a year costs more than ten months, or the prices cannot be compared", () => {
    expect(yearlySavingTrue(month(1900), year(19001))).toBe(false);
    expect(yearlySavingTrue(month(1900), year(19000, "eur"))).toBe(false);
    expect(yearlySavingTrue(month(1900), { ...year(19000), recurring: { interval: "month", interval_count: 12 } })).toBe(false);
    expect(yearlySavingTrue({ ...month(1900), recurring: { interval: "month", interval_count: 3 } }, year(19000))).toBe(false);
    expect(yearlySavingTrue({ ...month(0), unit_amount: null }, year(19000))).toBe(false);
    expect(yearlySavingTrue(null, year(19000))).toBe(false);
  });
});

describe("getYearlyPlanOffers", () => {
  const YEARLY_ENV = {
    ...ENV,
    STRIPE_PRICE_STARTER_YEARLY: "price_test_starter_year",
    STRIPE_PRICE_GROWTH_YEARLY: "price_test_growth_year",
  };

  beforeEach(() => {
    m.retrievePrice.mockImplementation(async (id: string) => {
      const amounts: Record<string, [number, string]> = {
        price_example_starter: [1900, "month"],
        price_example_growth: [3900, "month"],
        price_test_starter_year: [19000, "year"],
        price_test_growth_year: [46800, "year"],
      };
      const [unit_amount, interval] = amounts[id];
      return { id, unit_amount, currency: "usd", recurring: { interval, interval_count: 1 } };
    });
  });

  it("gives each plan with a yearly price Stripe's label, and the saving only where it is true", async () => {
    expect(await getYearlyPlanOffers(["starter", "growth", "pro"], YEARLY_ENV, NOW)).toEqual([
      { plan: "starter", name: "Starter", price: "$190 a year", twoMonthsFree: true },
      { plan: "growth", name: "Growth", price: "$468 a year", twoMonthsFree: false },
    ]);
  });

  it("reads each price once an hour, monthly ones shared with getPlanOffers", async () => {
    await getPlanOffers(["starter"], YEARLY_ENV, NOW);
    await getYearlyPlanOffers(["starter"], YEARLY_ENV, NOW);
    expect(m.retrievePrice.mock.calls.map((call) => call[0])).toEqual(["price_example_starter", "price_test_starter_year"]);
  });

  it("when Stripe cannot be reached: no prices and no saving claimed", async () => {
    m.retrievePrice.mockRejectedValue(new StripeApiError("Stripe could not be reached (TypeError)", 0));
    expect(await getYearlyPlanOffers(["starter"], YEARLY_ENV, NOW)).toEqual([
      { plan: "starter", name: "Starter", price: null, twoMonthsFree: false },
    ]);
  });

  it("with no yearly price configured: none, and Stripe is not asked", async () => {
    expect(await getYearlyPlanOffers(["starter", "growth"], ENV, NOW)).toEqual([]);
    expect(m.retrievePrice).not.toHaveBeenCalled();
  });
});
