import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** P1: POST /api/billing/checkout { plan, interval? }: interval is optional and monthly by default. */

const h = vi.hoisted(() => ({ requireOwnerContext: vi.fn(), checkRateLimit: vi.fn(), startCheckout: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/server/billing/checkout", () => ({ startCheckout: h.startCheckout }));

import { POST } from "./route";

const post = (body: unknown) =>
  new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_test_starter_month");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example");
  h.requireOwnerContext.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" }, workspace: { id: "ws-1" }, role: "owner" });
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  h.startCheckout.mockResolvedValue({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/billing/checkout", () => {
  it("without an interval asks for the monthly price, as old clients do", async () => {
    const response = await POST(post({ plan: "starter" }));
    expect(response.status).toBe(200);
    expect(h.startCheckout.mock.calls[0][0]).toMatchObject({ plan: "starter" });
    // startCheckout's default is monthly (server/billing/checkout.test.ts).
    expect(h.startCheckout.mock.calls[0][0]).not.toHaveProperty("interval");
  });

  it("passes interval month or year on", async () => {
    await POST(post({ plan: "starter", interval: "year" }));
    await POST(post({ plan: "starter", interval: "month" }));
    expect(h.startCheckout.mock.calls.map((call) => call[0].interval)).toEqual(["year", "month"]);
  });

  it("refuses any other interval in a plain sentence", async () => {
    const response = await POST(post({ plan: "starter", interval: "week" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose monthly or yearly." });
    expect(h.startCheckout).not.toHaveBeenCalled();
  });
});
