import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: the pricing page with payments configured and no yearly price, byte for
 * byte. Pinned from the released page before P1 changed it; P1 part 1 then
 * updated it once, on purpose, for what each plan includes. Part 2 (yearly
 * prices) must leave it exactly as it is: with no yearly price configured,
 * no switch and no other change.
 */

const { getPlanOffersMock } = vi.hoisted(() => ({ getPlanOffersMock: vi.fn() }));
vi.mock("@/server/billing/planPrices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing/planPrices")>()),
  getPlanOffers: getPlanOffersMock,
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));

import PricingPage from "./page";

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_test_starter_month");
  vi.stubEnv("STRIPE_PRICE_GROWTH", "price_test_growth_month");
  vi.stubEnv("STRIPE_PRICE_PRO", "price_test_pro_month");
  vi.stubEnv("STRIPE_PRICE_STARTER_YEARLY", undefined);
  vi.stubEnv("STRIPE_PRICE_GROWTH_YEARLY", undefined);
  vi.stubEnv("STRIPE_PRICE_PRO_YEARLY", undefined);
  vi.stubEnv("BILLING_TRIAL_DAYS", undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  getPlanOffersMock.mockReset();
  getPlanOffersMock.mockResolvedValue([
    { plan: "starter", name: "Starter", price: "$19 a month" },
    { plan: "growth", name: "Growth", price: "$39 a month" },
    { plan: "pro", name: "Pro", price: "$79 a month" },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("/pricing with monthly prices only", () => {
  it("renders the pinned page", async () => {
    expect(renderToString((await PricingPage()) as ReactElement)).toMatchSnapshot();
  });
});
