import { afterEach, beforeEach, describe, expect, it } from "vitest";

import sitemap from "./sitemap";

const PAGES = ["/", "/about", "/help", "/privacy", "/terms", "/data-deletion", "/register", "/login"];
const PAYMENTS = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  STRIPE_PRICE_STARTER: "price_starter",
};

describe("sitemap()", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["NEXTAUTH_URL", ...Object.keys(PAYMENTS)];
  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.NEXTAUTH_URL = "https://vibesocials.wtf";
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("lists the eight public pages with absolute addresses, without /pricing", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual(PAGES.map((p) => `https://vibesocials.wtf${p}`));
  });

  it("adds /pricing only when payments are configured", () => {
    Object.assign(process.env, PAYMENTS);
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://vibesocials.wtf/pricing");
    expect(urls).toHaveLength(9);
  });

  it("lists no signed-in path and no build-time date", () => {
    const entries = sitemap();
    for (const e of entries) {
      expect(e.lastModified).toBeUndefined();
      expect(e.url).not.toMatch(/\/(settings|posts|queue|activity|reports|media|reviews|workspaces|admin|api)(\/|$)/);
    }
  });
});
