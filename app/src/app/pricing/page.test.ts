import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPlanOffersMock, notFoundMock } = vi.hoisted(() => ({
  getPlanOffersMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

// No call to Stripe from a test: the cached price reader is mocked.
vi.mock("@/server/billing/planPrices", () => ({ getPlanOffers: getPlanOffersMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

import PricingPage, { generateMetadata } from "./page";

/** 23: the public pricing page. */

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function render(): Promise<string> {
  return renderToStaticMarkup((await PricingPage()) as ReactElement);
}

function configurePayments() {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  vi.stubEnv("STRIPE_PRICE_GROWTH", undefined);
  vi.stubEnv("STRIPE_PRICE_PRO", "price_pro");
  vi.stubEnv("BILLING_TRIAL_DAYS", "21");
}

beforeEach(() => {
  getPlanOffersMock.mockReset();
  notFoundMock.mockClear();
  for (const name of [
    "BILLING_ENABLED",
    "BILLING_TRIAL_DAYS",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_STARTER",
    "STRIPE_PRICE_GROWTH",
    "STRIPE_PRICE_PRO",
  ]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/pricing without payments configured", () => {
  it("answers the 404 with billing off, without asking for prices", async () => {
    await expect(PricingPage()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(generateMetadata()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPlanOffersMock).not.toHaveBeenCalled();
  });

  it("answers the 404 with billing on but no Stripe secrets", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
    await expect(PricingPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPlanOffersMock).not.toHaveBeenCalled();
  });
});

describe("/pricing with payments configured", () => {
  beforeEach(() => {
    configurePayments();
    getPlanOffersMock.mockResolvedValue([
      { plan: "starter", name: "Starter", price: "$99 a month" },
      { plan: "pro", name: "Pro", price: "€2,490.50 a year" },
    ]);
  });

  it("asks the cached reader for the offered plans only", async () => {
    await render();
    expect(getPlanOffersMock).toHaveBeenCalledTimes(1);
    expect(getPlanOffersMock.mock.calls[0][0]).toEqual(["starter", "pro"]);
  });

  it("shows one card per offered plan, in plan order, with Stripe's price as given", async () => {
    const page = text(await render());
    expect(page).toContain("Starter $99 a month");
    expect(page).toContain("Pro €2,490.50 a year");
    expect(page).not.toContain("Growth");
    expect(page.indexOf("Starter")).toBeLessThan(page.indexOf("Pro "));
    expect(page).not.toContain("Prices are unavailable");
  });

  it("says what each plan allows, in words from its limits", async () => {
    const page = text(await render());
    for (const line of [
      "Up to 20 posts a day",
      "Up to 30 posts to X a month",
      "Up to 10 YouTube uploads a day",
      "5 GB of photos and videos",
      "Up to 100 posts a day",
      "25 GB of photos and videos",
    ]) {
      expect(page).toContain(line);
    }
  });

  it("states the trial above the cards, and cancelling and the Terms under them", async () => {
    const html = await render();
    const page = text(html);
    expect(page).toContain("21-day free trial. No card needed to start.");
    expect(page.indexOf("21-day free trial")).toBeLessThan(page.indexOf("Starter"));
    expect(page).toContain(
      "Cancel any time in Settings. You keep access until the end of the period you paid for.",
    );
    expect(page.indexOf("Cancel any time")).toBeGreaterThan(page.indexOf("Pro "));
    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>/);
  });

  it("gives each card one button to start a trial", async () => {
    const html = await render();
    const buttons = html.match(/<a [^>]*href="\/register"[^>]*>Start your free trial<\/a>/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  it("shows the plans without prices, and says so, when Stripe cannot be reached", async () => {
    getPlanOffersMock.mockResolvedValue([
      { plan: "starter", name: "Starter", price: null },
      { plan: "pro", name: "Pro", price: null },
    ]);
    const page = text(await render());
    expect(page).toContain("Starter");
    expect(page).toContain("Pro");
    expect(page).toContain("Prices are unavailable right now. Try again in a minute.");
    expect(page).not.toMatch(/[$€£]\s?\d/);
  });

  it("has a title", async () => {
    expect(await generateMetadata()).toMatchObject({ title: "Pricing | Vibe Socials" });
  });
});

describe("/pricing: one plan per workspace (S1 item 3)", () => {
  it("says above the cards that each plan covers one workspace", async () => {
    configurePayments();
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: "$19 a month" }]);
    const page = text(await render());
    const sentence =
      "Each plan covers one workspace: one business with its own connected accounts. A second workspace needs its own plan once your trial ends.";
    expect(page).toContain(sentence);
    expect(page.indexOf(sentence)).toBeLessThan(page.indexOf("Starter"));
  });
});
