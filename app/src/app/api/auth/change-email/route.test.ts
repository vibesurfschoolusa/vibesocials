import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// R5 new-customer L4: a signed-in person asks to change their sign-in email.
const {
  getCurrentUserMock,
  checkRateLimitMock,
  userFindUniqueMock,
  requestDeleteManyMock,
  requestCreateMock,
  deliverAccountEmailMock,
  accountUndoWindowUntilMock,
  addressHeldUntilMock,
  clearPassedUndoWindowsMock,
} = vi.hoisted(() => ({
  accountUndoWindowUntilMock: vi.fn(),
  addressHeldUntilMock: vi.fn(),
  clearPassedUndoWindowsMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  requestDeleteManyMock: vi.fn(),
  requestCreateMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    user: { findUnique: userFindUniqueMock },
    emailChangeRequest: { deleteMany: requestDeleteManyMock, create: requestCreateMock },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});
vi.mock("@/server/auth/undoWindow", () => ({
  accountUndoWindowUntil: accountUndoWindowUntilMock,
  addressHeldUntil: addressHeldUntilMock,
  clearPassedUndoWindows: clearPassedUndoWindowsMock,
}));
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

let hash: string;

function user(overrides: Record<string, unknown> = {}) {
  return { id: "user-1", email: "old@example.com", passwordHash: hash, ...overrides };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/auth/change-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD = { newEmail: " New@Example.com ", currentPassword: "the-password" };

beforeAll(async () => {
  hash = await bcrypt.hash("the-password", 4);
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of [
    getCurrentUserMock,
    checkRateLimitMock,
    userFindUniqueMock,
    requestDeleteManyMock,
    requestCreateMock,
    deliverAccountEmailMock,
    accountUndoWindowUntilMock,
    addressHeldUntilMock,
    clearPassedUndoWindowsMock,
  ]) {
    mock.mockReset();
  }
  accountUndoWindowUntilMock.mockResolvedValue(null);
  addressHeldUntilMock.mockResolvedValue(null);
  clearPassedUndoWindowsMock.mockResolvedValue(undefined);
  getCurrentUserMock.mockResolvedValue(user());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  userFindUniqueMock.mockResolvedValue(null);
  requestDeleteManyMock.mockResolvedValue({ count: 0 });
  requestCreateMock.mockResolvedValue({});
  deliverAccountEmailMock.mockResolvedValue(true);
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
});

describe("POST /api/auth/change-email", () => {
  it("answers 401 to a signed-out caller", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await POST(request(GOOD))).status).toBe(401);
  });

  // R43 security L3: a fixed window, so the refusal says the wait it has left.
  it("over the limit with a few seconds left: says a minute, with Retry-After", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 8 });
    const response = await POST(request(GOOD));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("8");
    await expect(response.json()).resolves.toEqual({
      error: "Too many tries. Wait a minute, then try again.",
      retryAfterSeconds: 8,
    });
    expect(requestCreateMock).not.toHaveBeenCalled();
  });

  it("is rate limited per person and fails closed", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const response = await POST(request(GOOD));
    expect(response.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", route: "auth/change-email", failClosed: true }),
    );
    expect(requestCreateMock).not.toHaveBeenCalled();
  });

  it("refuses an account without a password", async () => {
    getCurrentUserMock.mockResolvedValue(user({ passwordHash: null }));
    const response = await POST(request(GOOD));
    expect(response.status).toBe(400);
    const { error } = await response.json();
    // R18 new-customer L2 follow-up: a signed-in person sees the notice on the
    // sign-in page, not its Forgot password link, so the page itself is named.
    expect(error).toBe(
      "You sign in with Google, so your sign-in email is your Google account's address. To use another address, set a password at /forgot-password, then change it here.",
    );
  });

  it("refuses an address that isn't one", async () => {
    const response = await POST(request({ ...GOOD, newEmail: "not-an-email" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Enter a valid email address." });
  });

  // R45 review M1: the shared check, linear and capped at 254 characters.
  it("refuses a 10,000-character address within milliseconds", async () => {
    const started = performance.now();
    const response = await POST(request({ ...GOOD, newEmail: "a.@".repeat(3334) + " " }));
    expect(performance.now() - started).toBeLessThan(50);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Enter a valid email address." });
  });

  it("refuses the address it already uses", async () => {
    const response = await POST(request({ ...GOOD, newEmail: "OLD@example.com" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "That is already your sign-in email." });
  });

  it("refuses a wrong current password and stores nothing", async () => {
    const response = await POST(request({ ...GOOD, currentPassword: "wrong" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your current password is not correct." });
    expect(requestCreateMock).not.toHaveBeenCalled();
  });

  it("answers 503 when email sending is not set up", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const response = await POST(request(GOOD));
    expect(response.status).toBe(503);
    expect(requestCreateMock).not.toHaveBeenCalled();
  });

  it("stores a hashed 24-hour request for the cleaned address and emails the link to it", async () => {
    const before = Date.now();
    const response = await POST(request(GOOD));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(requestDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
    const data = requestCreateMock.mock.calls[0][0].data;
    expect(data.userId).toBe("user-1");
    expect(data.newEmail).toBe("new@example.com");
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = data.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);

    const [to, email] = deliverAccountEmailMock.mock.calls[0];
    expect(to).toBe("new@example.com");
    expect(email.text).toContain("https://app.example.com/verify-email/new-address#");
    expect(email.text).not.toContain(data.tokenHash);
  });

  // No email-existence oracle: the answer is the same, and nothing is sent.
  it("answers the same when another account uses the address, and sends nothing", async () => {
    userFindUniqueMock.mockResolvedValue({ id: "someone-else" });
    const response = await POST(request(GOOD));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(requestCreateMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  // R6-security M1: while the previous address can undo the last change, the
  // account can't move on to a third address (the undo would then fail).
  it("refuses a new change while the last one can still be undone, and stores and sends nothing", async () => {
    const until = new Date("2026-11-17T12:00:00.000Z");
    accountUndoWindowUntilMock.mockResolvedValue(until);
    const response = await POST(request(GOOD));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You changed your email recently; you can change it again after November 17, 2026.",
      until: until.toISOString(),
    });
    expect(accountUndoWindowUntilMock).toHaveBeenCalledWith(expect.anything(), "user-1", expect.any(Date));
    expect(requestDeleteManyMock).not.toHaveBeenCalled();
    expect(requestCreateMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  // R6-security M1: another account's undo may still put this address back.
  it("answers the same when another account's undo may still take the address back, and sends nothing", async () => {
    addressHeldUntilMock.mockResolvedValue(new Date("2026-11-17T12:00:00.000Z"));
    const response = await POST(request(GOOD));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(addressHeldUntilMock).toHaveBeenCalledWith(expect.anything(), "new@example.com", expect.any(Date));
    expect(requestCreateMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  // R6-pages L6: previous addresses whose undo window has passed are cleared.
  it("clears the undo windows that have passed", async () => {
    await POST(request(GOOD));
    expect(clearPassedUndoWindowsMock).toHaveBeenCalledWith(expect.anything(), expect.any(Date));
  });

  it("answers 502 when the email could not be sent", async () => {
    deliverAccountEmailMock.mockResolvedValue(false);
    const response = await POST(request(GOOD));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("couldn't send the confirmation email");
  });

  it("answers 400 Invalid JSON body for a body that isn't an object", async () => {
    for (const raw of ["null", "[1]", "{not json"]) {
      const response = await POST(
        new Request("http://localhost/api/auth/change-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    }
  });
});
