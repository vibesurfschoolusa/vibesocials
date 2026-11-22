import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F3 (2026-11-14 review): POST /api/billing/portal opens Stripe's portal for
 * the active workspace, a cookie every tab shares, so the Plan section sends
 * the workspace its page was rendered for and the route refuses any other.
 */

const h = vi.hoisted(() => ({
  requireOwnerContext: vi.fn(),
  getWorkspaceContext: vi.fn(),
  isWorkspacePayer: vi.fn(),
  checkRateLimit: vi.fn(),
  openPortal: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext, getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/server/billing/checkout", () => ({ openPortal: h.openPortal }));
vi.mock("@/server/billing/payerRefusal", () => ({ isWorkspacePayer: h.isWorkspacePayer }));

import { NextResponse } from "next/server";

import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";

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

// Review of R5-security L2: the person whose card pays can manage it (and
// cancel) after being made a member, so the refusal to leave has a way out.
describe("POST /api/billing/portal for the payer who is no longer an owner", () => {
  const MEMBER = { user: { id: "user-2", email: "payer@example.com" }, workspace: { id: "ws-1" }, role: "member" };
  const forbidden = () => NextResponse.json({ error: "Your role or workspace changed. Reload the page." }, { status: 403 });

  it("opens the portal for the recorded payer", async () => {
    h.requireOwnerContext.mockResolvedValue(forbidden());
    h.getWorkspaceContext.mockResolvedValue(MEMBER);
    h.isWorkspacePayer.mockResolvedValue(true);

    const response = await POST(portal({ workspaceId: "ws-1" }));

    expect(response.status).toBe(200);
    expect(h.isWorkspacePayer).toHaveBeenCalledWith("ws-1", "user-2");
    expect(h.openPortal.mock.calls[0][0]).toMatchObject({ workspaceId: "ws-1" });
    expect(h.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-2", route: "billing/portal" }));
  });

  it("keeps the owner gate's 403 for any other member", async () => {
    h.requireOwnerContext.mockResolvedValue(forbidden());
    h.getWorkspaceContext.mockResolvedValue(MEMBER);
    h.isWorkspacePayer.mockResolvedValue(false);

    const response = await POST(portal({ workspaceId: "ws-1" }));

    expect(response.status).toBe(403);
    expect(h.openPortal).not.toHaveBeenCalled();
  });

  it("never asks about the payer for a signed-out caller", async () => {
    h.requireOwnerContext.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await POST(portal({ workspaceId: "ws-1" }))).status).toBe(401);
    expect(h.isWorkspacePayer).not.toHaveBeenCalled();
  });
});

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

// R43 security L1: the limit is 10 an hour, so the refusal says the real wait
// (the shared tooManyTriesResponse), and a store that couldn't be read keeps
// its own couldn't-check answer.
describe("POST /api/billing/portal over its limit", () => {
  it("says the wait in minutes, with Retry-After", async () => {
    h.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 59 * 60 - 5 });

    const response = await POST(portal({ workspaceId: "ws-1" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(59 * 60 - 5));
    expect(await response.json()).toEqual({
      error: "Too many tries. Wait 59 minutes, then try again.",
      retryAfterSeconds: 59 * 60 - 5,
    });
    expect(h.openPortal).not.toHaveBeenCalled();
  });

  it("a limit store that couldn't be read: the couldn't-check 503, never a wait", async () => {
    h.checkRateLimit.mockResolvedValue({ allowed: false, unavailable: true });

    const response = await POST(portal({ workspaceId: "ws-1" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
    expect(h.openPortal).not.toHaveBeenCalled();
  });
});
