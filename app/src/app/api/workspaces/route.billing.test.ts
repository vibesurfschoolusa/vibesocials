import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 21a: POST /api/workspaces with billing on. A new workspace starts a free
 * trial, and an owner of a workspace whose trial or plan ended cannot start
 * another. With billing off the existing route.test.ts pins today's behaviour.
 */

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  transaction: vi.fn(),
  workspaceCreate: vi.fn(),
  memberCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  getWorkspaceContext: vi.fn(),
  checkRateLimit: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workspaceMember: { findMany: h.findMany, count: h.count }, $transaction: h.transaction },
}));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: h.getWorkspaceContext,
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: h.cookieSet }) }));
vi.mock("@/server/usage/usageLog", () => ({
  workspaceCreationRefusal: vi.fn(async () => null),
  recordWorkspaceCreated: vi.fn(async () => undefined),
}));

import { POST } from "./route";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NAME_AND_PAUSE_SELECT = { name: true, pausedAt: true, pausedReason: true };

function request() {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Fresh start" }),
  });
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
  vi.stubEnv("BILLING_TRIAL_DAYS", "");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.getWorkspaceContext.mockResolvedValue({
    user: { id: "user-1", email: "owner@example.com" },
    workspace: { id: "ws-1", name: "Surf Co" },
    role: "owner",
  });
  h.findMany.mockResolvedValue([]);
  h.count.mockResolvedValue(1);
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  h.workspaceCreate.mockResolvedValue({ id: "ws-new", name: "Fresh start" });
  h.memberCreate.mockResolvedValue({});
  h.userFindUnique.mockResolvedValue({ email: "owner@example.com", emailVerifiedAt: null, trialStartedAt: null });
  h.userUpdateMany.mockResolvedValue({ count: 1 });
  h.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      workspace: { create: h.workspaceCreate },
      workspaceMember: { create: h.memberCreate },
      user: { findUnique: h.userFindUnique, updateMany: h.userUpdateMany },
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/workspaces with billing on", () => {
  it("a first workspace starts the caller's free trial, in the same transaction", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(h.workspaceCreate).toHaveBeenCalledWith({
      data: { name: "Fresh start", trialEndsAt: new Date(NOW.getTime() + 14 * DAY), billingExempt: false },
    });
    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", trialStartedAt: null },
      data: { trialStartedAt: NOW },
    });
  });

  it("a later workspace ends its trial with the caller's first window, even when that has passed", async () => {
    h.userFindUnique.mockResolvedValue({
      email: "owner@example.com",
      emailVerifiedAt: null,
      trialStartedAt: new Date(NOW.getTime() - 20 * DAY),
    });
    await POST(request());
    expect(h.workspaceCreate).toHaveBeenCalledWith({
      data: { name: "Fresh start", trialEndsAt: new Date(NOW.getTime() - 6 * DAY), billingExempt: false },
    });
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it("an operator's workspace is exempt with no trial", async () => {
    h.userFindUnique.mockResolvedValue({
      email: "ops@example.com",
      emailVerifiedAt: new Date("2026-11-01T00:00:00Z"),
      trialStartedAt: null,
    });
    await POST(request());
    expect(h.workspaceCreate).toHaveBeenCalledWith({ data: { name: "Fresh start", billingExempt: true } });
  });

  // R5-new-customer M2: an ended trial or plan blocks only that workspace. A
  // new workspace after the trial window starts ended anyway, so refusing it
  // protected nothing; only the operator's pause still blocks.
  it("reads only the names and pause columns of the caller's owned workspaces", async () => {
    await POST(request());
    expect(h.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", role: "owner" },
      select: { workspace: { select: NAME_AND_PAUSE_SELECT } },
    });
  });

  it("lets an owner of a workspace whose trial or plan ended create one", async () => {
    h.findMany.mockResolvedValue([
      { workspace: { name: "Old trial", pausedAt: null, pausedReason: null } },
      { workspace: { name: "Lapsed plan", pausedAt: null, pausedReason: null } },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(h.transaction).toHaveBeenCalled();
  });

  it("still refuses an owner of a paused workspace, naming it", async () => {
    h.findMany.mockResolvedValue([
      { workspace: { name: "Surf Co", pausedAt: new Date(NOW.getTime() - DAY), pausedReason: null } },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('while "Surf Co" is paused');
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("lets an owner of exempt workspaces (by flag, or never offered a trial) create one", async () => {
    h.findMany.mockResolvedValue([
      { workspace: { pausedAt: null, pausedReason: null, billingExempt: true } },
      { workspace: { pausedAt: null, pausedReason: null, billingExempt: false, plan: null, trialEndsAt: null } },
    ]);
    expect((await POST(request())).status).toBe(201);
  });
});

describe("GET /api/workspaces with billing on (S1 item 3)", () => {
  it("never carries it to an operator, whose new workspaces are exempt", async () => {
    const { GET } = await import("./route");
    h.getWorkspaceContext.mockResolvedValue({
      user: { id: "user-1", email: "ops@example.com", emailVerifiedAt: new Date("2026-11-01T00:00:00Z") },
      workspace: { id: "ws-1", name: "Ops" },
      role: "owner",
    });
    h.findMany.mockResolvedValue([]);
    const body = await (await GET()).json();
    expect(body.operatorLink).toBeDefined();
    expect(body.newWorkspaceNote).toBeUndefined();
  });

  it("carries the one-plan-per-workspace sentence for the New workspace form", async () => {
    const { GET } = await import("./route");
    h.findMany.mockResolvedValue([]);
    const body = await (await GET()).json();
    expect(body.newWorkspaceNote).toBe(
      "Each plan covers one workspace: one business with its own connected accounts. A second workspace needs its own plan once your trial ends.",
    );
  });
});
