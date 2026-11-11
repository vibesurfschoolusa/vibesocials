import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireOwnerContext: vi.fn(),
  checkRateLimit: vi.fn(),
  startCheckout: vi.fn(),
  openPortal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: m.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@/server/billing/checkout", () => ({ startCheckout: m.startCheckout, openPortal: m.openPortal }));

import * as checkout from "./checkout/route";
import * as portal from "./portal/route";

const CONFIGURED = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_STARTER: "price_example_starter",
  NEXTAUTH_URL: "https://app.example",
};

const OWNER = {
  user: { id: "user-1", email: "owner@example.com" },
  workspace: { id: "ws_1", name: "Surf Co" },
  role: "owner",
};

const post = (path: string, body?: unknown) =>
  new Request(`https://app.example${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

function configure(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

beforeEach(() => {
  m.requireOwnerContext.mockReset();
  m.requireOwnerContext.mockResolvedValue(OWNER);
  m.checkRateLimit.mockReset();
  m.checkRateLimit.mockResolvedValue({ allowed: true });
  m.startCheckout.mockReset();
  m.startCheckout.mockResolvedValue({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
  m.openPortal.mockReset();
  m.openPortal.mockResolvedValue({ ok: true, url: "https://billing.stripe.com/p/session/x" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("payments not configured", () => {
  it("both routes answer the app's JSON 404 to every method, before reading the session", async () => {
    configure({ ...CONFIGURED, STRIPE_SECRET_KEY: "" });
    for (const mod of [checkout, portal] as unknown as Array<Record<string, (r?: Request) => Promise<Response>>>) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const res = await mod[method](post("/api/billing/x", { plan: "starter" }));
        expect(res.status, method).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    }
    expect(m.requireOwnerContext).not.toHaveBeenCalled();
    expect(m.startCheckout).not.toHaveBeenCalled();
    expect(m.openPortal).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/checkout", () => {
  beforeEach(() => configure(CONFIGURED));

  it("returns Stripe's address for an owner", async () => {
    const res = await checkout.POST(post("/api/billing/checkout", { plan: "starter" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(m.startCheckout).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      ownerEmail: "owner@example.com",
      plan: "starter",
      now: expect.any(Date),
      baseUrl: "https://app.example",
    });
  });

  it("owner only: a member's 403 is answered as is", async () => {
    m.requireOwnerContext.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );
    const res = await checkout.POST(post("/api/billing/checkout", { plan: "starter" }));
    expect(res.status).toBe(403);
    expect(m.startCheckout).not.toHaveBeenCalled();
  });

  it("is rate limited to 10 an hour per user, failing closed", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await checkout.POST(post("/api/billing/checkout", { plan: "starter" }));
    expect(res.status).toBe(429);
    expect(m.checkRateLimit).toHaveBeenCalledWith({
      userId: "user-1",
      route: "billing/checkout",
      limit: 10,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
    expect(m.startCheckout).not.toHaveBeenCalled();
  });

  it("refuses a plan that is not one of the three, and a body that is not JSON", async () => {
    for (const body of [{ plan: "enterprise" }, {}, { plan: 3 }]) {
      const res = await checkout.POST(post("/api/billing/checkout", body));
      expect(res.status).toBe(400);
    }
    const res = await checkout.POST(
      new Request("https://app.example/api/billing/checkout", { method: "POST", body: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(m.startCheckout).not.toHaveBeenCalled();
  });

  it("answers a refusal with its status and sentence", async () => {
    m.startCheckout.mockResolvedValue({ ok: false, status: 409, error: "This workspace is billed by invoice." });
    const res = await checkout.POST(post("/api/billing/checkout", { plan: "starter" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This workspace is billed by invoice." });
  });
});

describe("POST /api/billing/portal", () => {
  beforeEach(() => configure(CONFIGURED));

  it("returns the portal's address for an owner", async () => {
    const res = await portal.POST(post("/api/billing/portal"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.com/p/session/x" });
    expect(m.openPortal).toHaveBeenCalledWith({ workspaceId: "ws_1", now: expect.any(Date), baseUrl: "https://app.example" });
  });

  it("owner only", async () => {
    m.requireOwnerContext.mockResolvedValue(NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }));
    expect((await portal.POST(post("/api/billing/portal"))).status).toBe(403);
    expect(m.openPortal).not.toHaveBeenCalled();
  });

  it("answers the refusal when there is no customer", async () => {
    m.openPortal.mockResolvedValue({ ok: false, status: 409, error: "This workspace has no plan to manage yet. Choose a plan first." });
    const res = await portal.POST(post("/api/billing/portal"));
    expect(res.status).toBe(409);
  });

  it("is rate limited, failing closed", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await portal.POST(post("/api/billing/portal"))).status).toBe(429);
    expect(m.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ route: "billing/portal", failClosed: true }));
  });

  it("no response carries a secret", async () => {
    const text = (await (await portal.POST(post("/api/billing/portal"))).text()) + (await (await checkout.POST(post("/api/billing/checkout", { plan: "starter" }))).text());
    expect(text).not.toContain("sk_test_example");
    expect(text).not.toContain("whsec_example");
  });
});
