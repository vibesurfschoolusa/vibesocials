import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// reset-password/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/rateLimit` at module scope — both mocked below. `@/lib/accountToken`'s
// `hashAccountToken` is kept REAL (pure sha256), so the tests can hash the raw
// token themselves to assert the lookup/where clauses.
const {
  checkRateLimitMock,
  findUniqueTokenMock,
  updateManyTokenMock,
  updateUserMock,
  transactionMock,
} = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  findUniqueTokenMock: vi.fn(),
  updateManyTokenMock: vi.fn(),
  updateUserMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: {
    accountToken: { findUnique: findUniqueTokenMock },
    $transaction: transactionMock,
  },
}));

import { hashAccountToken } from "@/lib/accountToken";
import { POST } from "./route";

const RAW_TOKEN = "raw-verify-token-value";
const INVALID_BODY = { error: "This link is invalid or has expired." };

function makeTokenRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tok-1",
    userId: "user-1",
    type: "email_verify",
    tokenHash: hashAccountToken(RAW_TOKEN),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    usedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    user: { emailVerifiedAt: null },
    ...overrides,
  };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  findUniqueTokenMock.mockReset();
  updateManyTokenMock.mockReset();
  updateUserMock.mockReset();
  transactionMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findUniqueTokenMock.mockResolvedValue(makeTokenRow());
  updateManyTokenMock.mockResolvedValue({ count: 1 });
  updateUserMock.mockResolvedValue({ id: "user-1" });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      accountToken: { updateMany: updateManyTokenMock },
      user: { update: updateUserMock },
    }),
  );
});

describe("POST /api/auth/verify-email", () => {
  it("checks the rate limit keyed by ip under route auth/verify (10/15min)", async () => {
    await POST(req({ token: RAW_TOKEN }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: expect.stringMatching(/^ip:/),
      route: "auth/verify",
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("returns 429 with Retry-After and never reads a token when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please slow down.",
      retryAfterSeconds: 30,
    });
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
  });

  it("returns the uniform 400 for a missing token without touching the db", async () => {
    const response = await POST(req({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
  });

  it("looks the token up by its sha256 hash and returns the uniform 400 for an unknown token", async () => {
    findUniqueTokenMock.mockResolvedValue(null);

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(findUniqueTokenMock).toHaveBeenCalledWith({
      where: { tokenHash: hashAccountToken(RAW_TOKEN) },
      include: { user: { select: { emailVerifiedAt: true } } },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for an already-used token (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ usedAt: new Date() }));

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for an expired token (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ expiresAt: new Date(Date.now() - 1000) }));

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for a token of the wrong type (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ type: "password_reset" }));

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("on the happy path claims the token and stamps emailVerifiedAt in ONE transaction — then 200 { ok: true }", async () => {
    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(transactionMock).toHaveBeenCalledTimes(1);

    // Atomic single-use claim: the conditional updateMany re-validates
    // usedAt/expiry INSIDE the transaction (TOCTOU guard, mirrors reset-password).
    expect(updateManyTokenMock).toHaveBeenCalledWith({
      where: {
        tokenHash: hashAccountToken(RAW_TOKEN),
        type: "email_verify",
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });

    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { emailVerifiedAt: expect.any(Date) },
    });

    // Ordering: claim the token before stamping the user.
    expect(updateManyTokenMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserMock.mock.invocationCallOrder[0],
    );
  });

  it("is idempotent — an already-verified user still consumes the token but is NOT re-stamped, still 200", async () => {
    findUniqueTokenMock.mockResolvedValue(
      makeTokenRow({ user: { emailVerifiedAt: new Date("2026-01-01T00:00:00Z") } }),
    );

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    // The token is still claimed (marked used) as an audit trail...
    expect(updateManyTokenMock).toHaveBeenCalledTimes(1);
    // ...but the first-verification timestamp is preserved (never re-stamped).
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("returns the uniform 400 and writes nothing when the in-transaction claim loses a race (count 0)", async () => {
    updateManyTokenMock.mockResolvedValue({ count: 0 });

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("returns 500 (not an unhandled rejection) when the transaction throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    transactionMock.mockRejectedValue(new Error("db down"));

    const response = await POST(req({ token: RAW_TOKEN }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to verify email." });

    consoleSpy.mockRestore();
  });
});
