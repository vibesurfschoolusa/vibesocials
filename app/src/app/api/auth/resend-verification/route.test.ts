import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// forgot-password/route.test.ts). route.ts imports `@/lib/auth`,
// `@/lib/rateLimit`, `@/lib/db` and `@/lib/accountEmails` at module scope, so
// they are mocked before route.ts is imported below. `@/lib/accountToken` is
// REAL, over an in-memory token table (R56: which links work after a send).
// `@/lib/logger` is left REAL (its console sink is spied where a catch path is
// exercised).
const {
  getCurrentUserMock,
  checkRateLimitMock,
  tokenTable,
  buildVerifyEmailMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  tokenTable: { current: null as unknown },
  buildVerifyEmailMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: {
    get accountToken() {
      return tokenTable.current;
    },
  },
}));

vi.mock("@/lib/accountEmails", () => ({
  buildVerifyEmail: buildVerifyEmailMock,
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { hashAccountToken } from "@/lib/accountToken";
import { makeFakeAccountTokenStore } from "@/lib/accountToken.fakeStore";

import { POST } from "./route";

let store: ReturnType<typeof makeFakeAccountTokenStore>;

const BUILT_EMAIL = { subject: "Verify your email address", html: "<html>", text: "text" };

function unverifiedUser(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "user-1", email: "user@example.com", emailVerifiedAt: null, ...overrides };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  buildVerifyEmailMock.mockReset();
  deliverAccountEmailMock.mockReset();

  getCurrentUserMock.mockResolvedValue(unverifiedUser());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  store = makeFakeAccountTokenStore();
  tokenTable.current = store.db.accountToken;
  buildVerifyEmailMock.mockReturnValue(BUILT_EMAIL);
  deliverAccountEmailMock.mockResolvedValue(true);

  // Deterministic email-configured baseline; individual tests override.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/resend-verification", () => {
  it("returns 401 for an anonymous caller and does no rate-limit or issuance work", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "You were signed out. Sign in again." });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(store.rows).toEqual([]);
  });

  it("checks the rate limit keyed by the user id under route auth/resend-verify (3/15min)", async () => {
    await POST();

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "auth/resend-verify",
      limit: 3,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("returns 429 with Retry-After and issues nothing when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toEqual({
      error: "Too many tries. Wait a minute, then try again.",
      retryAfterSeconds: 42,
    });
    expect(store.rows).toEqual([]);
  });

  it("returns 400 when the caller's email is already verified — no token issued, no email sent", async () => {
    getCurrentUserMock.mockResolvedValue(unverifiedUser({ emailVerifiedAt: new Date("2026-01-01T00:00:00Z") }));

    const response = await POST();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your email is already verified." });
    expect(store.rows).toEqual([]);
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("returns 503 and issues nothing when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    const response = await POST();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Email sending is not configured." });
    expect(store.rows).toEqual([]);
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("on the happy path issues an email_verify token and delivers the built email — 200 { ok: true }", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ userId: "user-1", type: "email_verify" });
    expect(buildVerifyEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com" }));
    expect(store.rows[0].tokenHash).toBe(hashAccountToken(buildVerifyEmailMock.mock.calls[0][0].rawToken));
    expect(deliverAccountEmailMock).toHaveBeenCalledWith("user@example.com", BUILT_EMAIL);
  });

  it("returns 500 (not an unhandled rejection) when issuance throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tokenTable.current = { create: vi.fn().mockRejectedValue(new Error("db down")), deleteMany: vi.fn() };

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't send the verification email just now. Please try again in a few minutes.",
    });

    consoleSpy.mockRestore();
  });

  // R5 new-customer L2: a delivery the email service refused is not "sent".
  it("returns 502 with a plain sentence when the email could not be delivered", async () => {
    deliverAccountEmailMock.mockResolvedValue(false);

    const response = await POST();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't send the verification email just now. Please try again in a few minutes.",
    });
  });

  // R56 new-customer L1, pages-a L4: a resend that fails leaves the link
  // already in the inbox working.
  describe("which link works after a resend", () => {
    const OLD = hashAccountToken("earlier-link");

    it("delivery accepted: the earlier link is retired and only the new one works", async () => {
      store.seed({ userId: "user-1", type: "email_verify", tokenHash: OLD });
      expect((await POST()).status).toBe(200);
      expect(store.hashes()).toEqual([hashAccountToken(buildVerifyEmailMock.mock.calls[0][0].rawToken)]);
    });

    it("delivery refused: the earlier link keeps working, the new one is removed, and the answer is as before", async () => {
      deliverAccountEmailMock.mockResolvedValue(false);
      store.seed({ userId: "user-1", type: "email_verify", tokenHash: OLD });
      const response = await POST();
      expect(response.status).toBe(502);
      expect(store.hashes()).toEqual([OLD]);
    });

    it("two resends in a row, both accepted: only the newest link works", async () => {
      await POST();
      await POST();
      expect(store.hashes()).toEqual([hashAccountToken(buildVerifyEmailMock.mock.calls[1][0].rawToken)]);
    });

    it("a used link is never deleted", async () => {
      const usedAt = new Date("2026-11-19T00:00:00.000Z");
      store.seed({ userId: "user-1", type: "email_verify", tokenHash: OLD, usedAt });
      await POST();
      expect(store.rows.find((row) => row.tokenHash === OLD)?.usedAt).toEqual(usedAt);
    });
  });
});
