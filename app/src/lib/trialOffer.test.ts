import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPlanOffersMock } = vi.hoisted(() => ({ getPlanOffersMock: vi.fn() }));
// No call to Stripe from a test: the cached price reader is mocked.
vi.mock("@/server/billing/planPrices", () => ({ getPlanOffers: getPlanOffersMock }));

import { startingPrice, trialButtonLabel, trialPriceLine } from "./trialOffer";

/** S1 item 2: what the landing and About pages say with payments configured. */

function configurePayments(prices: { starter?: string; growth?: string; pro?: string }) {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
  vi.stubEnv("STRIPE_PRICE_STARTER", prices.starter);
  vi.stubEnv("STRIPE_PRICE_GROWTH", prices.growth);
  vi.stubEnv("STRIPE_PRICE_PRO", prices.pro);
}

beforeEach(() => {
  getPlanOffersMock.mockReset();
  for (const name of ["BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO"]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trialButtonLabel", () => {
  it("names the real trial length", () => {
    expect(trialButtonLabel(14)).toBe("Start your 14-day free trial");
    expect(trialButtonLabel(21)).toBe("Start your 21-day free trial");
  });
});

describe("trialPriceLine", () => {
  it("names the starting price when there is one, and only the card line otherwise", () => {
    expect(trialPriceLine("$19 a month")).toBe("From $19 a month after the trial. No card needed to start.");
    expect(trialPriceLine(null)).toBe("No card needed to start.");
  });
});

describe("startingPrice", () => {
  it("asks Stripe for nothing when payments are not configured", async () => {
    expect(await startingPrice()).toBeNull();
    expect(getPlanOffersMock).not.toHaveBeenCalled();
  });

  it("reads the lowest offered plan's price through the cached reader", async () => {
    configurePayments({ starter: "price_s", growth: "price_g", pro: "price_p" });
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: "$19 a month" }]);
    expect(await startingPrice()).toBe("$19 a month");
    expect(getPlanOffersMock).toHaveBeenCalledWith(["starter"]);
  });

  it("starts from Growth when Starter is not offered", async () => {
    configurePayments({ growth: "price_g", pro: "price_p" });
    getPlanOffersMock.mockResolvedValue([{ plan: "growth", name: "Growth", price: "$39 a month" }]);
    expect(await startingPrice()).toBe("$39 a month");
    expect(getPlanOffersMock).toHaveBeenCalledWith(["growth"]);
  });

  it("is null when Stripe gave no price", async () => {
    configurePayments({ starter: "price_s" });
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: null }]);
    expect(await startingPrice()).toBeNull();
  });
});
