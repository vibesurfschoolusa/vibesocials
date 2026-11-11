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
    const links = pricingLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(">Pricing</a>");
  });

  it("has no Pricing link with billing on but payments not configured", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
    expect(pricingLinks()).toEqual([]);
  });
});
