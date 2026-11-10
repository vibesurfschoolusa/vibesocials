import bcrypt from "bcryptjs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getCurrentUserMock,
  userUpdateMock,
  transactionMock,
  checkRateLimitMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  userUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transactionMock,
    user: { update: vi.fn(() => Promise.reject(new Error("must write inside the transaction"))) },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
// deliverAccountEmail never throws (it logs and returns false), so the mock
// resolves false, the way a failed or unconfigured send really behaves.
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

let currentHash: string;
const USER_ID = "user-1";

function user(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, email: "owner@example.com", passwordHash: currentHash, sessionVersion: 3, ...overrides };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  currentHash = await bcrypt.hash("old-password", 4);
});

beforeEach(() => {
  getCurrentUserMock.mockReset();
  userUpdateMock.mockReset();
  transactionMock.mockReset();
  checkRateLimitMock.mockReset();
  deliverAccountEmailMock.mockReset();
  getCurrentUserMock.mockResolvedValue(user());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  deliverAccountEmailMock.mockResolvedValue(false);
  userUpdateMock.mockResolvedValue({});
  transactionMock.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({ user: { update: userUpdateMock } }),
  );
});

describe("POST /api/auth/change-password", () => {
  it("returns 401 when signed out", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(request({ currentPassword: "old-password", newPassword: "new-password" }));

    expect(response.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rate limits 5 attempts per 15 minutes per user", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await POST(request({ currentPassword: "old-password", newPassword: "new-password" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, limit: 5, windowMs: 15 * 60 * 1000 }),
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/auth/change-password", { method: "POST", body: "nope" }),
    );

    expect(response.status).toBe(400);
  });

  it("tells a Google-only user there is no password to change", async () => {
    getCurrentUserMock.mockResolvedValue(user({ passwordHash: null }));

    const response = await POST(request({ currentPassword: "x", newPassword: "new-password" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "You sign in with Google, so this account has no password to change.",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong current password", async () => {
    const response = await POST(request({ currentPassword: "not-it", newPassword: "new-password" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Your current password is not correct." });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a new password shorter than 8 characters", async () => {
    const response = await POST(request({ currentPassword: "old-password", newPassword: "short" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Password must be at least 8 characters." });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects a new password equal to the current one", async () => {
    const response = await POST(request({ currentPassword: "old-password", newPassword: "old-password" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Your new password must be different from your current one.",
    });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("writes a new hash and bumps sessionVersion in a transaction, then emails the user", async () => {
    const response = await POST(request({ currentPassword: "old-password", newPassword: "new-password" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    const { where, data } = userUpdateMock.mock.calls[0][0];
    expect(where).toEqual({ id: USER_ID });
    expect(data.sessionVersion).toEqual({ increment: 1 });
    expect(data.passwordHash).not.toBe(currentHash);
    await expect(bcrypt.compare("new-password", data.passwordHash)).resolves.toBe(true);
    expect(deliverAccountEmailMock).toHaveBeenCalledWith(
      "owner@example.com",
      expect.objectContaining({ subject: "Your Vibe Socials password was changed" }),
    );
  });

  it("still succeeds when the email is not sent", async () => {
    deliverAccountEmailMock.mockResolvedValue(false);

    const response = await POST(request({ currentPassword: "old-password", newPassword: "new-password" }));

    expect(response.status).toBe(200);
  });
});
