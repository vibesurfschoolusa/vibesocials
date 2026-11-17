import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uploadFindFirst: vi.fn(),
  uploadUpdateMany: vi.fn(),
  uploadCreate: vi.fn(),
  reviewFindFirst: vi.fn(),
  reviewUpdateMany: vi.fn(),
  reviewCreate: vi.fn(),
  connectFindFirst: vi.fn(),
  connectUpdateMany: vi.fn(),
  connectCreate: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  requireOwnerContext: vi.fn(),
  isWorkspaceOwner: vi.fn(),
  checkRateLimit: vi.fn(),
  generateInviteToken: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: m.transaction,
    workspaceUploadLink: { findFirst: m.uploadFindFirst },
    workspaceReviewLink: { findFirst: m.reviewFindFirst },
    workspaceConnectLink: { findFirst: m.connectFindFirst },
  },
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: m.requireOwnerContext, isWorkspaceOwner: m.isWorkspaceOwner }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@/lib/inviteToken", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inviteToken")>("@/lib/inviteToken");
  return { ...actual, generateInviteToken: m.generateInviteToken };
});

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/inviteToken";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { openSecret } from "@/lib/tokenCrypto";

import { DELETE, GET, POST } from "./route";

/**
 * R5-security L1: "Make new client links" replaces the upload link and the
 * review link in one press, so a former owner's copies stop working.
 */

const OWNER_CONTEXT = { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co" }, role: "owner" as const };
const CREATED = new Date("2026-11-14T10:00:00Z");

function request(body: unknown = { workspaceId: "ws-1" }): Request {
  return new Request("http://localhost/api/workspaces/client-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let tokens: string[];

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") fn.mockReset();
  m.calls = [];
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.NEXTAUTH_URL = "https://app.example.com";
  vi.stubEnv("BILLING_ENABLED", "");
  tokens = ["U".repeat(43), "V".repeat(43), "C".repeat(43)];
  vi.stubEnv("TIKTOK_CLIENT_KEY", "k");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "s");
  vi.stubEnv("TIKTOK_REDIRECT_URI", "r");
  m.generateInviteToken.mockImplementation(() => {
    const raw = tokens.shift()!;
    return { raw, hash: hashInviteToken(raw) };
  });
  m.requireOwnerContext.mockResolvedValue(OWNER_CONTEXT);
  m.checkRateLimit.mockResolvedValue({ allowed: true });
  m.executeRaw.mockImplementation(async (_strings: unknown, key: string) => {
    m.calls.push(`lock ${key}`);
  });
  m.uploadFindFirst.mockResolvedValue({ id: "up-old" });
  m.reviewFindFirst.mockResolvedValue({ id: "rev-old" });
  m.uploadUpdateMany.mockImplementation(async () => {
    m.calls.push("revoke upload");
    return { count: 1 };
  });
  m.reviewUpdateMany.mockImplementation(async () => {
    m.calls.push("revoke review");
    return { count: 1 };
  });
  m.uploadCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    m.calls.push("create upload");
    return { ...data, uploadCount: 0, lastUsedAt: null, createdAt: CREATED };
  });
  m.reviewCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    m.calls.push("create review");
    return { ...data, lastUsedAt: null, createdAt: CREATED };
  });
  m.connectFindFirst.mockResolvedValue(null);
  m.connectUpdateMany.mockImplementation(async () => {
    m.calls.push("revoke connect");
    return { count: 1 };
  });
  m.connectCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    m.calls.push("create connect");
    return { ...data, lastUsedAt: null, createdAt: CREATED };
  });
  m.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    m.calls.push("transaction");
    return callback({
      $executeRaw: m.executeRaw,
      workspaceUploadLink: { findFirst: m.uploadFindFirst, updateMany: m.uploadUpdateMany, create: m.uploadCreate },
      workspaceReviewLink: { findFirst: m.reviewFindFirst, updateMany: m.reviewUpdateMany, create: m.reviewCreate },
      workspaceConnectLink: { findFirst: m.connectFindFirst, updateMany: m.connectUpdateMany, create: m.connectCreate },
    });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.NEXTAUTH_URL;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/workspaces/client-links", () => {
  it("replaces both links in one transaction, under both link locks, and shows the new ones once", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      uploadLink: { url: `https://app.example.com/u/${"U".repeat(43)}`, uploadCount: 0, lastUsedAt: null, createdAt: CREATED.toISOString() },
      reviewLink: { url: `https://app.example.com/v/${"V".repeat(43)}`, lastUsedAt: null, createdAt: CREATED.toISOString() },
      connectLink: null,
    });
    expect(m.calls).toEqual([
      "transaction",
      "lock ws-review-link:ws-1",
      "lock ws-upload-link:ws-1",
      "lock ws-connect-link:ws-1",
      "revoke upload",
      "create upload",
      "revoke review",
      "create review",
    ]);
    expect(m.uploadUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    const created = m.uploadCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({ workspaceId: "ws-1", tokenHash: hashInviteToken("U".repeat(43)), createdById: "user-1" });
    expect(openSecret(created.tokenSealed)).toBe("U".repeat(43));
  });

  // R6 M2: the connect link is a client link too; a former owner could copy it.
  it("replaces the connect link with the same platforms, for 14 days, made by the owner who pressed", async () => {
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    tokens = ["C".repeat(43)];
    m.connectFindFirst.mockResolvedValue({ id: "con-old", platforms: ["tiktok", "linkedin"] });

    const body = await (await POST(request())).json();

    // Any working link, whoever made it (one a former owner made has stopped working).
    expect(m.connectFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true, platforms: true },
    });
    expect(m.calls.slice(-2)).toEqual(["revoke connect", "create connect"]);
    expect(m.connectUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    const created = m.connectCreate.mock.calls[0][0].data;
    // LinkedIn is not set up on this site, so only TikTok is offered again.
    expect(created).toMatchObject({ workspaceId: "ws-1", tokenHash: hashInviteToken("C".repeat(43)), createdById: "user-1", platforms: ["tiktok"] });
    expect(openSecret(created.tokenSealed)).toBe("C".repeat(43));
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 24 * 60 * 60 * 1000 - 60_000);
    expect(body.connectLink).toEqual({
      url: `https://app.example.com/c/${"C".repeat(43)}`,
      platforms: ["tiktok"],
      expiresAt: created.expiresAt.toISOString(),
      lastUsedAt: null,
      createdAt: CREATED.toISOString(),
    });
  });

  it("turns the connect link off when none of its platforms can be offered any more", async () => {
    m.connectFindFirst.mockResolvedValue({ id: "con-old", platforms: ["linkedin"] });

    const body = await (await POST(request())).json();

    expect(m.connectUpdateMany).toHaveBeenCalled();
    expect(m.connectCreate).not.toHaveBeenCalled();
    expect(body.connectLink).toBeNull();
    expect(body.connectLinkTurnedOff).toBe(true);
  });

  it("only replaces a link that is on; one that is off stays off", async () => {
    m.reviewFindFirst.mockResolvedValue(null);

    const body = await (await POST(request())).json();

    expect(body.reviewLink).toBeNull();
    expect(body.uploadLink.url).toContain("/u/");
    expect(m.reviewUpdateMany).not.toHaveBeenCalled();
    expect(m.reviewCreate).not.toHaveBeenCalled();
  });

  it("answers the gate's response for a member, and changes nothing", async () => {
    m.requireOwnerContext.mockResolvedValue(NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("refuses another workspace's id (a stale tab), and changes nothing", async () => {
    expect((await POST(request({ workspaceId: "ws-other" }))).status).toBe(409);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("is limited per owner and says so", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "You've made new client links 10 times this hour, counted across all your workspaces. Too many tries. Wait 5 minutes, then try again.",
    });
    expect(m.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", route: "workspaces/client-links", limit: 10, windowMs: 60 * 60 * 1000 }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("with billing on, a plan without client links refuses like the link routes", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, billingExempt: false, plan: "starter", planStatus: "active" },
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    // R7-pages L3: a plain sentence that says what still works.
    await expect(response.json()).resolves.toMatchObject({
      error:
        "This workspace's plan doesn't include client links, so new ones can't be made. To stop the old ones working, press Turn off client links.",
    });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  // R22 client-journey L1 / security L1: a link made while blocked answers "not active".
  it("refuses while the workspace is paused, with the panel's sentence, and touches no link", async () => {
    m.requireOwnerContext.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: null },
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: `Client links don't work right now. This workspace is paused. Contact ${SUPPORT_EMAIL}.`,
      code: "WORKSPACE_BLOCKED",
    });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.uploadUpdateMany).not.toHaveBeenCalled();
    expect(m.uploadCreate).not.toHaveBeenCalled();
    expect(m.checkRateLimit).not.toHaveBeenCalled();
  });

  it("with billing on and the trial ended, refuses the same way", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, billingExempt: false, plan: null, trialEndsAt: new Date(Date.now() - 86_400_000) },
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_BLOCKED" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("answers 500 with a plain sentence when the transaction fails", async () => {
    m.transaction.mockRejectedValue(new Error("db down"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Couldn't make new client links. The old ones still work. Try again.",
    });
  });
});

describe("GET /api/workspaces/client-links", () => {
  const get = (query = "?workspaceId=ws-1") => GET(new Request(`http://localhost/api/workspaces/client-links${query}`));

  it("says which client links are on and whether the plan includes them", async () => {
    m.reviewFindFirst.mockResolvedValue(null);
    m.connectFindFirst.mockResolvedValue({ createdById: "owner-2" });
    m.isWorkspaceOwner.mockResolvedValue(true);

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      included: true,
      on: { upload: true, review: false, connect: true },
      connectStopped: false,
    });
    expect(m.connectFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { createdById: true },
    });
    expect(m.isWorkspaceOwner).toHaveBeenCalledWith("owner-2", "ws-1");
  });

  // Check 4: a connect link made by someone no longer an owner works for nobody.
  it("says when the connect link has stopped working because its maker is no longer an owner", async () => {
    m.connectFindFirst.mockResolvedValue({ createdById: "former-1" });
    m.isWorkspaceOwner.mockResolvedValue(false);
    await expect((await get()).json()).resolves.toMatchObject({ on: { connect: true }, connectStopped: true });
  });

  it("reports a paused workspace with the panel's sentence; an active one has no such key", async () => {
    m.requireOwnerContext.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: null },
    });
    await expect((await get()).json()).resolves.toMatchObject({
      included: true,
      on: { upload: true, review: true, connect: false },
      workspaceBlocked: `Client links don't work right now. This workspace is paused. Contact ${SUPPORT_EMAIL}.`,
      workspaceBlockedBy: "pause",
    });
    m.requireOwnerContext.mockResolvedValue(OWNER_CONTEXT);
    expect(await (await get()).json()).not.toHaveProperty("workspaceBlocked");
    expect(await (await get()).json()).not.toHaveProperty("workspaceBlockedBy");
  });

  it("with billing on, a plan without client links answers included: false", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue({
      ...OWNER_CONTEXT,
      workspace: { ...OWNER_CONTEXT.workspace, billingExempt: false, plan: "starter", planStatus: "active" },
    });
    await expect((await get()).json()).resolves.toMatchObject({ included: false });
  });

  // R23 security L1 / client-journey L2: `included` is whether the plan itself
  // has client links, its ended state aside, so the Team card gives an ended
  // trial or Growth plan the block's wording, and only Starter the plan's.
  describe("with billing on, an ended trial or plan", () => {
    const ended = (fields: Record<string, unknown>) =>
      m.requireOwnerContext.mockResolvedValue({
        ...OWNER_CONTEXT,
        workspace: { ...OWNER_CONTEXT.workspace, billingExempt: false, ...fields },
      });
    const PAST = () => new Date(Date.now() - 86_400_000);
    const AGAIN = "Choose Growth or Pro in Settings and your client links work again, or contact";

    it("an ended trial: included, with the block's sentence", async () => {
      vi.stubEnv("BILLING_ENABLED", "true");
      ended({ plan: null, trialEndsAt: PAST() });
      await expect((await get()).json()).resolves.toMatchObject({
        included: true,
        workspaceBlocked: `Client links don't work right now. Your free trial has ended. ${AGAIN} ${SUPPORT_EMAIL}.`,
        workspaceBlockedBy: "plan",
      });
    });

    it("an ended Growth plan: included, with the block's sentence", async () => {
      vi.stubEnv("BILLING_ENABLED", "true");
      ended({ plan: "growth", planStatus: "canceled", currentPeriodEnd: PAST() });
      await expect((await get()).json()).resolves.toMatchObject({
        included: true,
        workspaceBlocked: `Client links don't work right now. Your plan has ended. ${AGAIN} ${SUPPORT_EMAIL}.`,
        workspaceBlockedBy: "plan",
      });
    });

    it("an ended Starter plan: not included, and the sentence says Starter has none", async () => {
      vi.stubEnv("BILLING_ENABLED", "true");
      ended({ plan: "starter", planStatus: "canceled", currentPeriodEnd: PAST() });
      await expect((await get()).json()).resolves.toMatchObject({
        included: false,
        workspaceBlocked: `Client links don't work right now. Your Starter plan has ended, and Starter doesn't include client links. ${AGAIN} ${SUPPORT_EMAIL}.`,
      });
    });
  });

  it("answers the gate's response for a member, and another workspace's id with 409", async () => {
    m.requireOwnerContext.mockResolvedValue(NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }));
    expect((await get()).status).toBe(403);
    m.requireOwnerContext.mockResolvedValue(OWNER_CONTEXT);
    expect((await get("?workspaceId=ws-other")).status).toBe(409);
    expect(m.uploadFindFirst).not.toHaveBeenCalled();
  });
});

// R7-pages L3 / client-journey L2: "Turn off client links" works on any plan,
// so the owners can stop a former owner's paused copies coming back.
describe("DELETE /api/workspaces/client-links", () => {
  const del = (body: unknown = { workspaceId: "ws-1" }) =>
    DELETE(
      new Request("http://localhost/api/workspaces/client-links", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const STARTER = {
    ...OWNER_CONTEXT,
    workspace: { ...OWNER_CONTEXT.workspace, billingExempt: false, plan: "starter", planStatus: "active" },
  };

  it("turns off the upload, review and connect links in one transaction, on a plan without client links", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue(STARTER);
    const response = await del();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const off = { where: { workspaceId: "ws-1", revokedAt: null }, data: { revokedAt: expect.any(Date) } };
    expect(m.uploadUpdateMany).toHaveBeenCalledWith(off);
    expect(m.reviewUpdateMany).toHaveBeenCalledWith(off);
    expect(m.connectUpdateMany).toHaveBeenCalledWith(off);
    expect(m.calls[0]).toBe("transaction");
    expect(m.uploadCreate).not.toHaveBeenCalled();
    expect(m.reviewCreate).not.toHaveBeenCalled();
    expect(m.connectCreate).not.toHaveBeenCalled();
  });

  it("works on a plan with client links too", async () => {
    expect((await del()).status).toBe(200);
    expect(m.uploadUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("answers the gate's response for a member, refuses another workspace's id, and changes nothing", async () => {
    m.requireOwnerContext.mockResolvedValue(NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }));
    expect((await del()).status).toBe(403);
    m.requireOwnerContext.mockResolvedValue(OWNER_CONTEXT);
    expect((await del({ workspaceId: "ws-other" })).status).toBe(409);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("answers 500 with a plain sentence when the transaction fails", async () => {
    m.transaction.mockRejectedValue(new Error("db down"));
    const response = await del();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Couldn't turn off the client links. Nothing changed. Try again.",
    });
  });
});

// R44 new-customer L1: the limit is a fixed hour counted across every workspace
// the person owns, so the refusal names the real wait, not "Try again later".
describe("the hourly limit names its wait", () => {
  it("at 40 minutes left: the reason, the wait in minutes, and Retry-After", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 40 * 60 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2400");
    await expect(response.json()).resolves.toEqual({
      error: "You've made new client links 10 times this hour, counted across all your workspaces. Too many tries. Wait 40 minutes, then try again.",
      retryAfterSeconds: 2400,
    });
  });
});
