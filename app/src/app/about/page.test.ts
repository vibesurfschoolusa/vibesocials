import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPlanOffersMock } = vi.hoisted(() => ({ getPlanOffersMock: vi.fn() }));
// No call to Stripe from a test: the cached price reader is mocked.
vi.mock("@/server/billing/planPrices", () => ({ getPlanOffers: getPlanOffersMock }));

import AboutPage from "./page";

/** S1 item 2. Billing off: src/app/publicPagesBillingOff.test.ts pins the page. */

beforeEach(() => {
  getPlanOffersMock.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_TRIAL_DAYS", "21");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function render(): Promise<string> {
  return renderToStaticMarkup((await AboutPage()) as ReactElement);
}

describe("About with payments configured", () => {
  it("offers the trial with its length and the starting price, and links to Pricing", async () => {
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: "$19 a month" }]);
    const html = await render();
    expect(html).not.toContain("Create free account");
    expect(html).toContain("Start your 21-day free trial");
    expect(html).toContain("From $19 a month after the trial. No card needed to start.");
    expect(html).toMatch(/<a [^>]*href="\/pricing"[^>]*>See pricing<\/a>/);
  });

  it("says only that no card is needed when no price could be read", async () => {
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: null }]);
    const html = await render();
    expect(html).toContain("No card needed to start.");
    expect(html).not.toContain("after the trial");
  });
});
