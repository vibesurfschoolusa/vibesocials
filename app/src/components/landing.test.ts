import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Landing } from "./landing";

/** 23: the Pricing link. Billing off: src/app/publicPagesBillingOff.test.ts pins the page. */

afterEach(() => {
  vi.unstubAllEnvs();
});

function pricingLinks(): string[] {
  return renderToStaticMarkup(createElement(Landing)).match(/<a [^>]*href="\/pricing"[^>]*>[^<]*<\/a>/g) ?? [];
}

describe("Landing", () => {
  it("links to Pricing in the header when payments are configured", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
    vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
    // S1 added "See pricing" under each trial button; the header's link is the one named Pricing.
    const links = pricingLinks().filter((link) => link.includes(">Pricing</a>"));
    expect(links).toHaveLength(1);
  });

  it("has no Pricing link with billing on but payments not configured", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
    expect(pricingLinks()).toEqual([]);
  });
});

/** S1 item 2: with payments configured the page offers the trial, not a free account. */
describe("Landing with payments configured", () => {
  function configure() {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("BILLING_TRIAL_DAYS", undefined);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
    vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  }

  it("offers the trial with its length and the starting price, and links to Pricing", () => {
    configure();
    const html = renderToStaticMarkup(createElement(Landing, { startingPrice: "$19 a month" }));
    expect(html).not.toContain("Create free account");
    expect(html).not.toMatch(/no credit card/i);
    expect(html.match(/Start your 14-day free trial/g)).toHaveLength(2);
    expect(html.match(/From \$19 a month after the trial\. No card needed to start\./g)).toHaveLength(2);
    expect(html.match(/href="\/pricing"/g)?.length).toBe(3);
  });

  it("says only that no card is needed when no price could be read", () => {
    configure();
    const html = renderToStaticMarkup(createElement(Landing, { startingPrice: null }));
    expect(html).not.toContain("From ");
    expect(html.match(/No card needed to start\./g)).toHaveLength(2);
  });
});
