import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 23: platform reviewers and customers read these pages today. With billing
 * off (no billing variable set, as in production), each must render exactly
 * what it rendered before pricing existed. The snapshots were written from the
 * base branch's pages, before any of them changed; a difference here is a
 * change reviewers would see. renderToString, not renderToStaticMarkup: its
 * output keeps the markers React puts between adjacent text in the served HTML,
 * so a condition that splits a sentence into two text nodes shows up here.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn(), getProviders: vi.fn(async () => null) }));

const BILLING_VARS = [
  "BILLING_ENABLED",
  "BILLING_TRIAL_DAYS",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_GROWTH",
  "STRIPE_PRICE_PRO",
];

beforeAll(() => {
  for (const name of BILLING_VARS) vi.stubEnv(name, undefined);
  // The landing footer prints the year.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function render(load: () => Promise<{ default: () => unknown }>): Promise<string> {
  const Page = (await load()).default;
  const element = await Page();
  return renderToString(element as ReactElement);
}

describe("public pages with billing off", () => {
  it("Terms renders today's page", async () => {
    expect(await render(() => import("./terms/page"))).toMatchSnapshot();
  });

  it("Privacy renders today's page", async () => {
    expect(await render(() => import("./privacy/page"))).toMatchSnapshot();
  });

  it("Register renders today's page", async () => {
    expect(await render(() => import("./register/page"))).toMatchSnapshot();
  });

  // S1: pinned from the released pages before the self-serve batch changed any of them.
  it("About renders today's page", async () => {
    expect(await render(() => import("./about/page"))).toMatchSnapshot();
  });

  it("Log in renders today's page", async () => {
    expect(await render(() => import("./login/page"))).toMatchSnapshot();
  });

  it("Help renders today's page", async () => {
    expect(await render(() => import("./help/page"))).toMatchSnapshot();
  });

  it("Pricing is an unknown page", async () => {
    const { default: PricingPage, generateMetadata } = await import("./pricing/page");
    await expect(PricingPage()).rejects.toThrow();
    await expect(generateMetadata()).rejects.toThrow();
  });

  it("the landing page renders today's page", async () => {
    const { Landing } = await import("@/components/landing");
    expect(renderToString(createElement(Landing))).toMatchSnapshot();
  });
});
