import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uploadFindFirst: vi.fn(),
  uploadUpdateMany: vi.fn(),
  uploadCreate: vi.fn(),
  reviewFindFirst: vi.fn(),
  reviewUpdateMany: vi.fn(),
  reviewCreate: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  requireOwnerContext: vi.fn(),
  checkRateLimit: vi.fn(),
  generateInviteToken: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/db", () => ({ prisma: { $transaction: m.transaction } }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: m.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@/lib/inviteToken", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inviteToken")>("@/lib/inviteToken");
  return { ...actual, generateInviteToken: m.generateInviteToken };
});

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/inviteToken";
import { openSecret } from "@/lib/tokenCrypto";

import { POST } from "./route";

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
  tokens = ["U".repeat(43), "V".repeat(43)];
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
  m.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    m.calls.push("transaction");
    return callback({
      $executeRaw: m.executeRaw,
      workspaceUploadLink: { findFirst: m.uploadFindFirst, updateMany: m.uploadUpdateMany, create: m.uploadCreate },
      workspaceReviewLink: { findFirst: m.reviewFindFirst, updateMany: m.reviewUpdateMany, create: m.reviewCreate },
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
    });
    expect(m.calls).toEqual([
      "transaction",
      "lock ws-review-link:ws-1",
      "lock ws-upload-link:ws-1",
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
      error: "You made new client links many times this hour. Try again later.",
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
