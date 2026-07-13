import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// forgot-password/route.test.ts). route.ts imports `@/lib/auth`,
// `@/lib/rateLimit`, `@/lib/db`, `@/lib/accountToken`, and `@/lib/accountEmails`
// at module scope, so all must be mocked before route.ts is imported below.
// `@/lib/logger` is left REAL (its console sink is spied where a catch path is
// exercised).
const {
  getCurrentUserMock,
  checkRateLimitMock,
  transactionMock,
  issueAccountTokenMock,
  buildVerifyEmailMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  transactionMock: vi.fn(),
  issueAccountTokenMock: vi.fn(),
  buildVerifyEmailMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: { $transaction: transactionMock },
}));

vi.mock("@/lib/accountToken", () => ({ issueAccountToken: issueAccountTokenMock }));

vi.mock("@/lib/accountEmails", () => ({
  buildVerifyEmail: buildVerifyEmailMock,
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

const BUILT_EMAIL = { subject: "Verify your email address", html: "<html>", text: "text" };

function unverifiedUser(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: "user-1", email: "user@example.com", emailVerifiedAt: null, ...overrides };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  transactionMock.mockReset();
  issueAccountTokenMock.mockReset();
  buildVerifyEmailMock.mockReset();
  deliverAccountEmailMock.mockReset();

  getCurrentUserMock.mockResolvedValue(unverifiedUser());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ accountToken: {} }));
  issueAccountTokenMock.mockResolvedValue("raw-verify-token");
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
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
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
      error: "Too many requests. Please slow down.",
      retryAfterSeconds: 42,
    });
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the caller's email is already verified — no token issued, no email sent", async () => {
    getCurrentUserMock.mockResolvedValue(unverifiedUser({ emailVerifiedAt: new Date("2026-01-01T00:00:00Z") }));

    const response = await POST();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your email is already verified." });
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("returns 503 and issues nothing when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    const response = await POST();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Email sending is not configured." });
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("on the happy path issues an email_verify token and delivers the built email — 200 { ok: true }", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(issueAccountTokenMock).toHaveBeenCalledWith(expect.anything(), "user-1", "email_verify");
    expect(buildVerifyEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", rawToken: "raw-verify-token" }),
    );
    expect(deliverAccountEmailMock).toHaveBeenCalledWith("user@example.com", BUILT_EMAIL);
  });

  it("returns 500 (not an unhandled rejection) when issuance throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    transactionMock.mockRejectedValue(new Error("db down"));

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to send verification email." });

    consoleSpy.mockRestore();
  });
});
