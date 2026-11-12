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
      "Up to 3 posts a day (about 90 a month)",
      "Up to 15 posts to X a month",
      "Up to 1 YouTube upload a day",
      "2 GB of photos and videos",
      "Up to 15 posts a day (about 450 a month)",
      "15 GB of photos and videos",
    ]) {
      expect(page).toContain(line);
    }
  });

  // S1 fix round 1: the access-to-period-end line is true only for one portal
  // setting, so cancelling is said by the FAQ answer (Settings, Plan, the Terms).
  it("states the trial above the cards, and cancelling and the Terms under them", async () => {
    const html = await render();
    const page = text(html);
    expect(page).toContain("21-day free trial. No card needed to start.");
    expect(page.indexOf("21-day free trial")).toBeLessThan(page.indexOf("Starter"));
    expect(page).not.toContain("You keep access");
    expect(page).toContain("Cancel any time in Settings, under Plan.");
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

describe("/pricing sells and explains (S1 item 5)", () => {
  beforeEach(() => {
    configurePayments();
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: "$19 a month" }]);
  });

  it("sits in the public site's header and footer", async () => {
    const html = await render();
    expect(html).toMatch(/<header[^>]*>[\s\S]*Vibe Socials[\s\S]*<\/header>/);
    expect(html).toMatch(/<nav aria-label="Main"[^>]*>[\s\S]*href="\/about"[\s\S]*href="\/login"[\s\S]*<\/nav>/);
    expect(html).toMatch(/<footer[^>]*>[\s\S]*operated by[\s\S]*href="\/terms"[\s\S]*<\/footer>/);
  });

  it("says above the cards what every plan includes", async () => {
    const page = text(await render());
    const lines = [
      "Every plan includes:",
      "Google Business Profile posts with buttons, offers and events.",
      "AI drafts of replies to your Google reviews.",
      "Links your clients use to send photos, approve posts and connect their accounts, without an account of their own.",
      "A monthly report with the calls, direction requests and website clicks from your Google listing.",
    ];
    for (const line of lines) {
      expect(page).toContain(line);
      expect(page.indexOf(line)).toBeLessThan(page.indexOf("Starter"));
    }
  });

  it("answers the common questions under the cards, true to the code and the Terms", async () => {
    const page = text(await render());
    const answers = [
      "What is a workspace?",
      "A workspace is one business: its connected accounts, posts, media and team.",
      "What happens when the trial ends?",
      "Posting stops until you choose a plan. A scheduled post that comes due while there is no plan is marked failed, and you can retry it from Activity once you have chosen a plan, as long as its photos and videos are still kept. Photos and videos of finished posts (published, failed or cancelled) are removed 30 days after they were last added to a post.",
      "How do I cancel?",
      "Cancel any time in Settings, under Plan. The Terms say what happens to the time you have already paid for. When the plan ends, the workspace works as after a trial.",
      "Do you give refunds?",
      "We do not refund a period that has already started, except where the law requires it.",
      "Who do I write to?",
    ];
    for (const answer of answers) {
      expect(page).toContain(answer);
      expect(page.indexOf(answer)).toBeGreaterThan(page.indexOf("Starter"));
    }
    expect(await render()).toMatch(/<a [^>]*href="mailto:[^"]+"/);
    // S1 follow-up: the 30-day media sweep runs on every workspace, so no absolute.
    expect(page).not.toMatch(/nothing is deleted|nothing has been deleted/i);
  });
});

describe("/pricing: the cancel answer holds whatever the Stripe portal does (S1 follow-up)", () => {
  it("links the Terms instead of promising access to the end of the period", async () => {
    configurePayments();
    getPlanOffersMock.mockResolvedValue([{ plan: "starter", name: "Starter", price: "$19 a month" }]);
    const html = await render();
    const faq = html.slice(html.indexOf("How do I cancel?"), html.indexOf("Do you give refunds?"));
    expect(faq).toMatch(/The <a [^>]*href="\/terms"[^>]*>Terms<\/a> say what happens/);
    expect(text(faq)).not.toContain("You keep access");
  });
});
