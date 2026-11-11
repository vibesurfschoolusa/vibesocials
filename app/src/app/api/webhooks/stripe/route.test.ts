import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ handleStripeEvent: vi.fn() }));
vi.mock("@/server/billing/stripeWebhook", () => ({ handleStripeEvent: m.handleStripeEvent }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import * as route from "./route";

const CONFIGURED = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
};
const BODY = '{"id":"evt_1","type":"customer.subscription.updated","data":{"object":{"id":"sub_1"}}}';

function signed(body: string, secret = "whsec_example", t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function post(body: string, signature?: string): Request {
  return new Request("https://app.example/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: signature ? { "Stripe-Signature": signature } : {},
  });
}

function configure(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value ?? "");
}

beforeEach(() => {
  m.handleStripeEvent.mockReset();
  m.handleStripeEvent.mockResolvedValue(200);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/webhooks/stripe, payments not configured", () => {
  it("answers the app's JSON 404 to every method and handles nothing, even with a valid signature", async () => {
    configure({ ...CONFIGURED, BILLING_ENABLED: "" });
    const res = await route.POST(post(BODY, signed(BODY)));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const other = await (route as unknown as Record<string, () => Promise<Response>>)[method]();
      expect(other.status, method).toBe(404);
    }
    expect(m.handleStripeEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe, configured", () => {
  beforeEach(() => configure(CONFIGURED));

  it("hands a correctly signed event to the handler, parsed from the raw body", async () => {
    const res = await route.POST(post(BODY, signed(BODY)));
    expect(res.status).toBe(200);
    expect(m.handleStripeEvent).toHaveBeenCalledWith(JSON.parse(BODY));
  });

  it("answers 400 and does nothing for a missing, wrong or stale signature", async () => {
    for (const signature of [
      undefined,
      "garbage",
      signed(BODY, "whsec_other"),
      signed(BODY, "whsec_example", Math.floor(Date.now() / 1000) - 600),
    ]) {
      const res = await route.POST(post(BODY, signature));
      expect(res.status, String(signature)).toBe(400);
    }
    expect(m.handleStripeEvent).not.toHaveBeenCalled();
  });

  it("verifies the bytes received: a re-serialised body fails", async () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    const res = await route.POST(post(pretty, signed(BODY)));
    expect(res.status).toBe(400);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const res = await route.POST(post("not json", signed("not json")));
    expect(res.status).toBe(400);
    expect(m.handleStripeEvent).not.toHaveBeenCalled();
  });

  it("passes the handler's 500 on, so Stripe sends the event again", async () => {
    m.handleStripeEvent.mockResolvedValue(500);
    const res = await route.POST(post(BODY, signed(BODY)));
    expect(res.status).toBe(500);
  });

  it("never puts a secret in a response", async () => {
    for (const res of [await route.POST(post(BODY, signed(BODY))), await route.POST(post(BODY, "bad"))]) {
      const text = await res.text();
      expect(text).not.toContain("whsec_example");
      expect(text).not.toContain("sk_test_example");
    }
  });
});
