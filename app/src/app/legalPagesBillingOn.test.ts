import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BILLING_TERMS_LAST_UPDATED } from "@/lib/billingTerms";
import { LEGAL_LAST_UPDATED } from "@/lib/siteInfo";

import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";

/** 23: Terms and Privacy with billing on. Billing off: publicPagesBillingOff.test.ts pins today's pages. */

function text(element: unknown): string {
  return renderToStaticMarkup(element as ReactElement)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_TRIAL_DAYS", "21");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Terms with billing on", () => {
  it("replaces section 7 with how payment works", () => {
    const page = text(TermsPage());
    for (const sentence of [
      "Our plans and their prices are on the pricing page .",
      "A new account starts with a 21-day free trial. No card is needed to start it.",
      "A paid plan renews at the end of each billing period until you cancel it.",
      "You can cancel any time in Settings, under Plan. You keep access until the end of the period you have paid for.",
      "If a payment fails, we try again. If it still fails, posting stops 7 days after the period ends.",
      "We do not refund a period that has already started, except where the law requires it.",
      "We may change our prices. We will tell you by email at least 30 days before a new price applies to you.",
      "Taxes may be added to the price where they apply.",
    ]) {
      expect(page).toContain(sentence);
    }
    expect(page).not.toContain("The Service is currently free.");
  });

  it("links the pricing page from section 7", () => {
    expect(renderToStaticMarkup(TermsPage() as ReactElement)).toMatch(/<a [^>]*href="\/pricing"[^>]*>pricing page<\/a>/);
  });

  it("drops \"(currently zero)\" from section 10", () => {
    const page = text(TermsPage());
    expect(page).toContain("in the 12 months before the claim.");
    expect(page).not.toContain("(currently zero)");
  });

  it("shows the billing terms' date, not today's", () => {
    const page = text(TermsPage());
    expect(page).toContain(`Last updated: ${BILLING_TERMS_LAST_UPDATED}`);
    expect(page).not.toContain(LEGAL_LAST_UPDATED);
    expect(page.match(/Last updated:/g)).toHaveLength(1);
  });
});

describe("Privacy with billing on", () => {
  it("says Stripe handles card payments and what the app keeps", () => {
    const page = text(PrivacyPage());
    expect(page).toContain(
      "Card payments are handled by Stripe. We never see or store your card number. We store your plan, its status and its dates, and the customer and subscription identifiers Stripe gives us.",
    );
  });
});

describe("billingTerms.ts", () => {
  it("starts with the DRAFT comment, verbatim", () => {
    const source = readFileSync(fileURLToPath(new URL("../lib/billingTerms.ts", import.meta.url)), "utf8");
    expect(source.split("\n")[0]).toBe(
      "// DRAFT. The operator must read, correct and approve this text before switching billing on. It was written by an AI assistant, not a lawyer.",
    );
  });
});
