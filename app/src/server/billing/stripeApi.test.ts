import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STRIPE_API_VERSION,
  StripeApiError,
  cancelSubscription,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  encodeForm,
  expireCheckoutSession,
  listCheckoutSessions,
  listCustomerSubscriptions,
  retrievePrice,
  retrieveSubscription,
  stripeIdempotencyKey,
} from "./stripeApi";

const SECRET = "sk_test_example";
const ENV = { STRIPE_SECRET_KEY: SECRET };

const fetchMock = vi.fn();

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  const headers = new Headers(init.headers);
  return { url, init, headers, body: typeof init.body === "string" ? new URLSearchParams(init.body) : null };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodeForm", () => {
  it("encodes nested objects and arrays with Stripe's bracket notation", () => {
    const form = encodeForm({
      mode: "subscription",
      line_items: [{ price: "price_example_starter", quantity: 1 }],
      subscription_data: { metadata: { workspaceId: "ws_1" }, trial_end: 1800000000 },
      skipped: undefined,
      alsoSkipped: null,
    });
    expect([...form.entries()]).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price]", "price_example_starter"],
      ["line_items[0][quantity]", "1"],
      ["subscription_data[metadata][workspaceId]", "ws_1"],
      ["subscription_data[trial_end]", "1800000000"],
    ]);
  });
});

describe("every request", () => {
  it("goes to api.stripe.com with the secret as a bearer token and the pinned version", async () => {
    fetchMock.mockResolvedValue(ok({ id: "sub_1", object: "subscription" }));
    await retrieveSubscription("sub_1", ENV);
    const { url, init, headers } = lastCall();
    expect(url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(init.method).toBe("GET");
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION).toBe("2026-10-28.endive");
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it("never puts the secret in the URL or the body", async () => {
    fetchMock.mockResolvedValue(ok({ id: "cus_1" }));
    await createCustomer({ workspaceId: "ws_1", email: "owner@example.com" }, "key-1", ENV);
    const { url, init } = lastCall();
    expect(url).not.toContain(SECRET);
    expect(String(init.body)).not.toContain(SECRET);
  });

  it("escapes an id used in the path", async () => {
    fetchMock.mockResolvedValue(ok({ id: "x" }));
    await retrieveSubscription("sub_1/../customers", ENV);
    expect(lastCall().url).toBe("https://api.stripe.com/v1/subscriptions/sub_1%2F..%2Fcustomers");
  });

  it("throws StripeApiError with Stripe's status and code, never the secret", async () => {
    fetchMock.mockResolvedValue(
      ok({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription" } }, 404),
    );
    const error = await retrieveSubscription("sub_missing", ENV).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect((error as StripeApiError).status).toBe(404);
    expect((error as StripeApiError).code).toBe("resource_missing");
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("throws StripeApiError on a network failure, without the secret", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await retrieveSubscription("sub_1", ENV).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect((error as StripeApiError).status).toBe(0);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("refuses to call Stripe without a secret", async () => {
    await expect(retrieveSubscription("sub_1", {})).rejects.toBeInstanceOf(StripeApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the calls", () => {
  it("createCustomer posts the email and the workspace id with an idempotency key", async () => {
    fetchMock.mockResolvedValue(ok({ id: "cus_1" }));
    const customer = await createCustomer({ workspaceId: "ws_1", email: "owner@example.com" }, "vs-customer-ws_1", ENV);
    const { url, init, headers, body } = lastCall();
    expect(customer.id).toBe("cus_1");
    expect(url).toBe("https://api.stripe.com/v1/customers");
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("Idempotency-Key")).toBe("vs-customer-ws_1");
    expect(body?.get("email")).toBe("owner@example.com");
    expect(body?.get("metadata[workspaceId]")).toBe("ws_1");
  });

  it("createCheckoutSession posts a subscription session", async () => {
    fetchMock.mockResolvedValue(ok({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const session = await createCheckoutSession(
      {
        customer: "cus_1",
        priceId: "price_example_starter",
        workspaceId: "ws_1",
        trialEnd: 1800000000,
        successUrl: "https://app.example/settings?billing=success#plan",
        cancelUrl: "https://app.example/settings#plan",
      },
      "vs-checkout-ws_1-starter-1",
      ENV,
    );
    const { url, headers, body } = lastCall();
    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(headers.get("Idempotency-Key")).toBe("vs-checkout-ws_1-starter-1");
    expect(Object.fromEntries(body!.entries())).toEqual({
      mode: "subscription",
      customer: "cus_1",
      "line_items[0][price]": "price_example_starter",
      "line_items[0][quantity]": "1",
      client_reference_id: "ws_1",
      "subscription_data[metadata][workspaceId]": "ws_1",
      "subscription_data[trial_end]": "1800000000",
      success_url: "https://app.example/settings?billing=success#plan",
      cancel_url: "https://app.example/settings#plan",
    });
  });

  it("createCheckoutSession leaves trial_end out when there is none", async () => {
    fetchMock.mockResolvedValue(ok({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }));
    await createCheckoutSession(
      {
        customer: "cus_1",
        priceId: "price_example_starter",
        workspaceId: "ws_1",
        trialEnd: null,
        successUrl: "https://app.example/s",
        cancelUrl: "https://app.example/c",
      },
      "k",
      ENV,
    );
    expect(lastCall().body?.has("subscription_data[trial_end]")).toBe(false);
  });

  it("createPortalSession posts the customer and the return address", async () => {
    fetchMock.mockResolvedValue(ok({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" }));
    const session = await createPortalSession({ customer: "cus_1", returnUrl: "https://app.example/settings#plan" }, "k", ENV);
    const { url, body, headers } = lastCall();
    expect(session.url).toBe("https://billing.stripe.com/p/session/x");
    expect(url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(headers.get("Idempotency-Key")).toBe("k");
    expect(Object.fromEntries(body!.entries())).toEqual({
      customer: "cus_1",
      return_url: "https://app.example/settings#plan",
    });
  });

  it("listCustomerSubscriptions reads every status for the customer", async () => {
    fetchMock.mockResolvedValue(ok({ object: "list", data: [{ id: "sub_1", status: "active" }], has_more: false }));
    const list = await listCustomerSubscriptions("cus_1", ENV);
    expect(list).toEqual([{ id: "sub_1", status: "active" }]);
    expect(lastCall().url).toBe("https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all&limit=100");
    expect(lastCall().init.method).toBe("GET");
  });

  it("cancelSubscription sends DELETE with no idempotency key", async () => {
    fetchMock.mockResolvedValue(ok({ id: "sub_1", status: "canceled" }));
    const sub = await cancelSubscription("sub_1", ENV);
    expect(sub.status).toBe("canceled");
    const { url, init, headers } = lastCall();
    expect(url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(init.method).toBe("DELETE");
    expect(headers.get("Idempotency-Key")).toBeNull();
  });

  it("listCheckoutSessions reads the customer's sessions of every status", async () => {
    fetchMock.mockResolvedValue(
      ok({ object: "list", data: [{ id: "cs_2", status: "open" }, { id: "cs_1", status: "expired" }], has_more: false }),
    );
    expect(await listCheckoutSessions("cus_1", ENV)).toEqual([
      { id: "cs_2", status: "open" },
      { id: "cs_1", status: "expired" },
    ]);
    expect(lastCall().url).toBe("https://api.stripe.com/v1/checkout/sessions?customer=cus_1&limit=100");
    expect(lastCall().init.method).toBe("GET");
  });

  it("expireCheckoutSession posts to the session's expire path with a key", async () => {
    fetchMock.mockResolvedValue(ok({ id: "cs_1", status: "expired" }));
    await expireCheckoutSession("cs_1", "vs-expire-cs_1", ENV);
    const { url, init, headers } = lastCall();
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_1/expire");
    expect(init.method).toBe("POST");
    expect(headers.get("Idempotency-Key")).toBe("vs-expire-cs_1");
  });

  it("retrievePrice reads one price", async () => {
    fetchMock.mockResolvedValue(ok({ id: "price_example_pro", unit_amount: 24900, currency: "usd" }));
    const price = await retrievePrice("price_example_pro", ENV);
    expect(price.unit_amount).toBe(24900);
    expect(lastCall().url).toBe("https://api.stripe.com/v1/prices/price_example_pro");
  });
});

describe("stripeIdempotencyKey", () => {
  it("joins what the request is for with a time bucket, so a double click in the bucket repeats one key", () => {
    const at = Date.UTC(2026, 10, 10, 12, 0, 30);
    const a = stripeIdempotencyKey(["checkout", "ws_1", "starter"], 10 * 60 * 1000, at);
    const b = stripeIdempotencyKey(["checkout", "ws_1", "starter"], 10 * 60 * 1000, at + 60_000);
    const c = stripeIdempotencyKey(["checkout", "ws_1", "starter"], 10 * 60 * 1000, at + 10 * 60 * 1000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("vs-checkout-ws_1-starter-")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(255);
  });

  it("without a bucket, is fixed by its parts", () => {
    expect(stripeIdempotencyKey(["customer", "ws_1"])).toBe("vs-customer-ws_1");
  });
});
