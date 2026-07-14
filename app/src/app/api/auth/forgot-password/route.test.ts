import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// invites/[token]/accept/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/rateLimit`, `@/lib/accountToken`, and `@/lib/accountEmails` at module
// scope, so all must be mocked before route.ts is imported below. `@/lib/logger`
// is left REAL (its console sink is spied where a catch path is exercised).
const {
  checkRateLimitMock,
  findUniqueUserMock,
  transactionMock,
  issueAccountTokenMock,
  buildPasswordResetEmailMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  transactionMock: vi.fn(),
  issueAccountTokenMock: vi.fn(),
  buildPasswordResetEmailMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: findUniqueUserMock },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/accountToken", () => ({ issueAccountToken: issueAccountTokenMock }));

vi.mock("@/lib/accountEmails", () => ({
  buildPasswordResetEmail: buildPasswordResetEmailMock,
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

const BUILT_EMAIL = { subject: "Reset your Vibe Socials password", html: "<html>", text: "text" };

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  findUniqueUserMock.mockReset();
  transactionMock.mockReset();
  issueAccountTokenMock.mockReset();
  buildPasswordResetEmailMock.mockReset();
  deliverAccountEmailMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findUniqueUserMock.mockResolvedValue(null);
  // The route wraps issuance in a $transaction; invoke the callback with a
  // structural tx (issueAccountToken is mocked, so the shape is irrelevant).
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ accountToken: {} }));
  issueAccountTokenMock.mockResolvedValue("raw-reset-token");
  buildPasswordResetEmailMock.mockReturnValue(BUILT_EMAIL);
  deliverAccountEmailMock.mockResolvedValue(true);
});

describe("POST /api/auth/forgot-password", () => {
  it("returns 400 for an invalid email and never touches the rate limit or db", async () => {
    const response = await POST(req({ email: "not-an-email" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Enter a valid email address." });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(findUniqueUserMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing email body", async () => {
    const response = await POST(req({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Enter a valid email address." });
  });

  it("checks BOTH the per-email and per-ip rate limits before any db read", async () => {
    findUniqueUserMock.mockResolvedValue({ id: "user-1", email: "user@x.com" });

    await POST(req({ email: "user@x.com" }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "email:user@x.com",
      route: "auth/forgot",
      limit: 3,
      windowMs: 15 * 60 * 1000,
    });
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: expect.stringMatching(/^ip:/),
      route: "auth/forgot-ip",
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("normalizes the per-email throttle key to lowercase but looks the user up AS-TYPED (review Important #1)", async () => {
    findUniqueUserMock.mockResolvedValue(null);

    await POST(req({ email: "User@X.com" }));

    // Case rotation ("User@x.com", "uSer@X.com", ...) must not mint fresh
    // rate-limit buckets for the same mailbox.
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "email:user@x.com",
      route: "auth/forgot",
      limit: 3,
      windowMs: 15 * 60 * 1000,
    });
    // The lookup stays as-typed: the app's email model is uniformly
    // case-sensitive (register/login store + compare as-typed), so a
    // normalized lookup would MISS mixed-case-registered accounts.
    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { email: "User@X.com" },
      select: { id: true, email: true },
    });
  });

  it("returns 429 with Retry-After and never reads the db when rate limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(req({ email: "user@x.com" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please slow down.",
      retryAfterSeconds: 42,
    });
    expect(findUniqueUserMock).not.toHaveBeenCalled();
  });

  it("returns 200 { ok: true } for an UNKNOWN email — no token issued, no email sent", async () => {
    findUniqueUserMock.mockResolvedValue(null);

    const response = await POST(req({ email: "ghost@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("for a KNOWN email issues a password_reset token and delivers the built email, still 200 { ok: true }", async () => {
    findUniqueUserMock.mockResolvedValue({ id: "user-9", email: "known@x.com" });

    const response = await POST(req({ email: "known@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(issueAccountTokenMock).toHaveBeenCalledWith(expect.anything(), "user-9", "password_reset");
    expect(buildPasswordResetEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "known@x.com", rawToken: "raw-reset-token" }),
    );
    // Delivery is best-effort and never branched on (no-oracle), but it IS
    // attempted with the built email for the known user.
    expect(deliverAccountEmailMock).toHaveBeenCalledWith("known@x.com", BUILT_EMAIL);
  });

  it("returns a byte-identical 200 body for known vs unknown email (no existence oracle)", async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: "user-1", email: "known@x.com" });
    const knownResponse = await POST(req({ email: "known@x.com" }));

    findUniqueUserMock.mockResolvedValueOnce(null);
    const unknownResponse = await POST(req({ email: "ghost@x.com" }));

    expect(knownResponse.status).toBe(unknownResponse.status);
    expect(knownResponse.status).toBe(200);
    await expect(knownResponse.json()).resolves.toEqual({ ok: true });
    await expect(unknownResponse.json()).resolves.toEqual({ ok: true });
  });

  it("still returns 200 { ok: true } when issuance throws (failure must not leak as an oracle)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findUniqueUserMock.mockResolvedValue({ id: "user-1", email: "known@x.com" });
    transactionMock.mockRejectedValue(new Error("db down"));

    const response = await POST(req({ email: "known@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    consoleSpy.mockRestore();
  });
});
