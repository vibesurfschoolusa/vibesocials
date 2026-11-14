import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F3 (2026-11-14 review): POST /api/billing/portal opens Stripe's portal for
 * the active workspace, a cookie every tab shares, so the Plan section sends
 * the workspace its page was rendered for and the route refuses any other.
 */

const h = vi.hoisted(() => ({ requireOwnerContext: vi.fn(), checkRateLimit: vi.fn(), openPortal: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/server/billing/checkout", () => ({ openPortal: h.openPortal }));

import { POST } from "./route";

const portal = (body: unknown) =>
  new Request("http://localhost/api/billing/portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example");
  h.requireOwnerContext.mockResolvedValue({ user: { id: "user-1", email: "owner@example.com" }, workspace: { id: "ws-1" }, role: "owner" });
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  h.openPortal.mockResolvedValue({ ok: true, url: "https://billing.stripe.com/p/session_1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/billing/portal and the rendered workspace", () => {
  it("opens the portal for the page's workspace", async () => {
    const response = await POST(portal({ workspaceId: "ws-1" }));
    expect(response.status).toBe(200);
    expect(h.openPortal.mock.calls[0][0]).toMatchObject({ workspaceId: "ws-1" });
  });

  it("409s another workspace's id, and asks Stripe for nothing", async () => {
    const response = await POST(portal({ workspaceId: "ws-2" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(h.openPortal).not.toHaveBeenCalled();
  });

  it("400s a body without the id, and asks Stripe for nothing", async () => {
    const response = await POST(portal({}));
    expect(response.status).toBe(400);
    expect(h.openPortal).not.toHaveBeenCalled();
  });
});
