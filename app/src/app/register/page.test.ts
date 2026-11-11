import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn(), getProviders: vi.fn(async () => null) }));

import RegisterPage from "./page";

/** 23: Register with billing on. Billing off: publicPagesBillingOff.test.ts pins today's page. */

function render(): string {
  return renderToStaticMarkup(RegisterPage() as ReactElement);
}

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_TRIAL_DAYS", "21");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Register with billing on", () => {
  it("says how long the trial is, under the button", () => {
    const html = render();
    expect(html).toContain("21-day free trial. No card needed.");
    expect(html.indexOf("21-day free trial")).toBeGreaterThan(html.indexOf("Create account</"));
  });

  it("says what the person agrees to, with links to both", () => {
    const html = render();
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "By creating an account you agree to the Terms and the Privacy Policy.",
    );
    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  });

  it("uses the default trial length when none is set", () => {
    vi.stubEnv("BILLING_TRIAL_DAYS", undefined);
    expect(render()).toContain("14-day free trial. No card needed.");
  });
});

describe("Register with billing off", () => {
  it("says nothing about a trial or terms", () => {
    vi.stubEnv("BILLING_ENABLED", undefined);
    const html = render();
    expect(html).not.toContain("free trial");
    expect(html).not.toContain("you agree");
  });
});
