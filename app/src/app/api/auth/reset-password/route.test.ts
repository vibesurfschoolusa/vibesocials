import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// invites/[token]/accept/route.test.ts). route.ts imports `bcryptjs`,
// `@/lib/db`, and `@/lib/rateLimit` at module scope — all mocked below.
// `@/lib/accountToken`'s `hashAccountToken` is kept REAL (pure sha256), so the
// tests can hash the raw token themselves to assert the lookup/where clauses.
const {
  bcryptHashMock,
  checkRateLimitMock,
  findUniqueTokenMock,
  updateManyTokenMock,
  deleteManyTokenMock,
  updateUserMock,
  transactionMock,
  changeRequestDeleteManyMock,
  clearLoginLimitMock,
} = vi.hoisted(() => ({
  clearLoginLimitMock: vi.fn(),
  changeRequestDeleteManyMock: vi.fn(),
  bcryptHashMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueTokenMock: vi.fn(),
  updateManyTokenMock: vi.fn(),
  deleteManyTokenMock: vi.fn(),
  updateUserMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: { hash: bcryptHashMock } }));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/loginLimit", () => ({ clearLoginLimitForNetwork: clearLoginLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: {
    accountToken: { findUnique: findUniqueTokenMock },
    $transaction: transactionMock,
  },
}));

import { hashAccountToken } from "@/lib/accountToken";
import { POST } from "./route";

const RAW_TOKEN = "raw-reset-token-value";
const INVALID_BODY = { error: "This link is invalid or has expired." };

function makeTokenRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tok-1",
    userId: "user-1",
    type: "password_reset",
    tokenHash: hashAccountToken(RAW_TOKEN),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    usedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    user: { emailVerifiedAt: null, email: "owner@example.test" },
    ...overrides,
  };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  bcryptHashMock.mockReset();
  checkRateLimitMock.mockReset();
  findUniqueTokenMock.mockReset();
  updateManyTokenMock.mockReset();
  deleteManyTokenMock.mockReset();
  updateUserMock.mockReset();
  transactionMock.mockReset();
  changeRequestDeleteManyMock.mockReset();
  changeRequestDeleteManyMock.mockResolvedValue({ count: 0 });
  clearLoginLimitMock.mockReset();
  clearLoginLimitMock.mockResolvedValue(undefined);

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  bcryptHashMock.mockResolvedValue("new-hashed-password");
  findUniqueTokenMock.mockResolvedValue(makeTokenRow());
  updateManyTokenMock.mockResolvedValue({ count: 1 });
  deleteManyTokenMock.mockResolvedValue({ count: 0 });
  updateUserMock.mockResolvedValue({ id: "user-1" });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      accountToken: { updateMany: updateManyTokenMock, deleteMany: deleteManyTokenMock },
      user: { update: updateUserMock },
      emailChangeRequest: { deleteMany: changeRequestDeleteManyMock },
    }),
  );
});

describe("POST /api/auth/reset-password", () => {
  it("checks the rate limit keyed by ip under route auth/reset (10/15min)", async () => {
    await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: expect.stringMatching(/^ip:/),
      route: "auth/reset",
      limit: 10,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
  });

  it("returns 429 with Retry-After and never reads a token when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      error: "Too many tries. Wait a minute, then try again.",
      retryAfterSeconds: 30,
    });
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
  });

  it("returns 400 with the register-matched rule for a password shorter than 8 chars", async () => {
    const response = await POST(req({ token: RAW_TOKEN, password: "short" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Password must be at least 8 characters.",
    });
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
  });

  // R46 security L3: bcrypt would ignore everything past byte 72.
  it("refuses a password over 72 bytes with the plain sentence and never reads the token", async () => {
    for (const password of ["x".repeat(73), "密".repeat(25)]) {
      const response = await POST(req({ token: RAW_TOKEN, password }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Use a shorter password: at most 72 bytes. Accented and non-Latin letters count as 2 to 3 bytes.",
      });
    }
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
    expect(bcryptHashMock).not.toHaveBeenCalled();
  });

  it("accepts a password of exactly 72 bytes", async () => {
    const response = await POST(req({ token: RAW_TOKEN, password: "x".repeat(72) }));
    expect(response.status).toBe(200);
  });

  it("returns the uniform 400 for a missing token", async () => {
    const response = await POST(req({ password: "brandnewpassword" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(findUniqueTokenMock).not.toHaveBeenCalled();
  });

  it("looks the token up by its sha256 hash and returns the uniform 400 for an unknown token", async () => {
    findUniqueTokenMock.mockResolvedValue(null);

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(findUniqueTokenMock).toHaveBeenCalledWith({
      where: { tokenHash: hashAccountToken(RAW_TOKEN) },
      include: { user: { select: { emailVerifiedAt: true, email: true } } },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for an already-used token (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ usedAt: new Date() }));

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for an expired token (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ expiresAt: new Date(Date.now() - 1000) }));

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME uniform 400 for a token of the wrong type (no oracle)", async () => {
    findUniqueTokenMock.mockResolvedValue(makeTokenRow({ type: "email_verify" }));

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("on the happy path marks the token used, updates the password, and deletes sibling tokens in ONE transaction — then 200 { ok: true }", async () => {
    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(transactionMock).toHaveBeenCalledTimes(1);

    // Atomic single-use claim: the conditional updateMany re-validates
    // usedAt/expiry INSIDE the transaction (TOCTOU guard, mirrors invites accept).
    expect(updateManyTokenMock).toHaveBeenCalledWith({
      where: {
        tokenHash: hashAccountToken(RAW_TOKEN),
        type: "password_reset",
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });

    expect(bcryptHashMock).toHaveBeenCalledWith("brandnewpassword", 10);

    // Password written + sessionVersion bumped + email verified (was null)
    // in the same transaction.
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        passwordHash: "new-hashed-password",
        sessionVersion: { increment: 1 },
        emailVerifiedAt: expect.any(Date),
      },
    });

    // Any OTHER still-unused reset token for this user is invalidated.
    expect(deleteManyTokenMock).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "password_reset", usedAt: null },
    });

    // Ordering: claim the token before writing the new password.
    expect(updateManyTokenMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserMock.mock.invocationCallOrder[0],
    );
  });

  // R6-security L2: a pending email change may have been asked for by whoever
  // the reset locks out, so its link stops working too.
  // R32 new-customer L1: 10 wrong passwords, then Forgot password; the new
  // password must work at once from that network, not after the window ends.
  it("after a reset, clears the sign-in limit for that address on the network the reset came from", async () => {
    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(response.status).toBe(200);
    expect(clearLoginLimitMock).toHaveBeenCalledTimes(1);
    expect(clearLoginLimitMock).toHaveBeenCalledWith("owner@example.test", "203.0.113.9");
  });

  it("clears nothing when the link is dead or the claim loses", async () => {
    findUniqueTokenMock.mockResolvedValueOnce(makeTokenRow({ usedAt: new Date() }));
    await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));
    updateManyTokenMock.mockResolvedValueOnce({ count: 0 });
    await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));
    expect(clearLoginLimitMock).not.toHaveBeenCalled();
  });

  it("a failed clear never fails the reset (the password did change)", async () => {
    clearLoginLimitMock.mockRejectedValue(new Error("store down"));
    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("deletes unused email-change requests (and so their links) in the same transaction", async () => {
    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));
    expect(response.status).toBe(200);
    expect(changeRequestDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
  });

  it("deletes no email-change request when the claim loses (count 0)", async () => {
    updateManyTokenMock.mockResolvedValue({ count: 0 });
    await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));
    expect(changeRequestDeleteManyMock).not.toHaveBeenCalled();
  });

  it("does NOT touch emailVerifiedAt when the account is already verified", async () => {
    findUniqueTokenMock.mockResolvedValue(
      makeTokenRow({ user: { emailVerifiedAt: new Date("2026-01-01T00:00:00Z") } }),
    );

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(200);
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        passwordHash: "new-hashed-password",
        sessionVersion: { increment: 1 },
      },
    });
  });

  it("returns the uniform 400 and writes nothing when the in-transaction claim loses to a concurrent use (count 0)", async () => {
    updateManyTokenMock.mockResolvedValue({ count: 0 });

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_BODY);
    expect(bcryptHashMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(deleteManyTokenMock).not.toHaveBeenCalled();
  });

  it("returns 500 (not an unhandled rejection) when the transaction throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    transactionMock.mockRejectedValue(new Error("db down"));

    const response = await POST(req({ token: RAW_TOKEN, password: "brandnewpassword" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to reset password." });

    consoleSpy.mockRestore();
  });
});
