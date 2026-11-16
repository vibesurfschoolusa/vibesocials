import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashAccountToken } from "@/lib/accountToken";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";

// Review item 1: "This wasn't me: undo" from the old mailbox.
const {
  checkRateLimitMock,
  findUniqueMock,
  claimMock,
  userUpdateManyMock,
  accountTokenDeleteManyMock,
  requestDeleteManyMock,
  followMock,
  afterMock,
  issueAccountTokenMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  afterMock: vi.fn(),
  issueAccountTokenMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueMock: vi.fn(),
  claimMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  accountTokenDeleteManyMock: vi.fn(),
  requestDeleteManyMock: vi.fn(),
  followMock: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));
vi.mock("@/lib/accountToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountToken")>()),
  issueAccountToken: issueAccountTokenMock,
}));
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: deliverAccountEmailMock,
}));
vi.mock("@/server/billing/customerEmail", () => ({ followEmailChangeInStripe: followMock }));
vi.mock("@/lib/db", () => {
  const tx = {
    emailChangeRequest: { updateMany: claimMock, deleteMany: requestDeleteManyMock },
    user: { updateMany: userUpdateManyMock },
    accountToken: { deleteMany: accountTokenDeleteManyMock },
  };
  return {
    prisma: {
      emailChangeRequest: { findUnique: findUniqueMock },
      $transaction: async (cb: (t: unknown) => unknown) => cb(tx),
    },
  };
});

import { POST } from "./route";

const NOW = Date.now();

function request(body: unknown): Request {
  return new Request("http://localhost/api/auth/change-email/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    userId: "user-1",
    newEmail: "new@example.com",
    previousEmail: "old@example.com",
    undoTokenHash: hashAccountToken("undo-token"),
    undoExpiresAt: new Date(NOW + 60_000),
    undoneAt: null,
    user: { email: "new@example.com" },
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    checkRateLimitMock,
    findUniqueMock,
    claimMock,
    userUpdateManyMock,
    accountTokenDeleteManyMock,
    requestDeleteManyMock,
    followMock,
    afterMock,
    issueAccountTokenMock,
    deliverAccountEmailMock,
  ]) {
    mock.mockReset();
  }
  afterMock.mockImplementation(() => undefined);
  issueAccountTokenMock.mockResolvedValue("raw-reset-token");
  deliverAccountEmailMock.mockResolvedValue(true);
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findUniqueMock.mockResolvedValue(record());
  claimMock.mockResolvedValue({ count: 1 });
  userUpdateManyMock.mockResolvedValue({ count: 1 });
  accountTokenDeleteManyMock.mockResolvedValue({ count: 0 });
  requestDeleteManyMock.mockResolvedValue({ count: 0 });
  followMock.mockResolvedValue(undefined);
});

describe("POST /api/auth/change-email/undo", () => {
  // R7-new-customer H1: a change from an address that was never confirmed
  // opens no window and sends no link; a request marked so is refused even
  // if a token for it turned up, so the unconfirmed address can never take
  // the account.
  it("refuses a change whose previous address was never confirmed, and changes nothing", async () => {
    findUniqueMock.mockResolvedValue(record({ previousEmailUnverified: true }));
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `This change can't be undone with a link, because the address it replaced was never confirmed. If this is your account, write to ${SUPPORT_EMAIL}.`,
    });
    expect(claimMock).not.toHaveBeenCalled();
    expect(userUpdateManyMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("is rate limited by network and fails closed", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await POST(request({ token: "undo-token" }))).status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ip:203.0.113.9", route: "auth/change-email-undo", failClosed: true }),
    );
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("puts the previous address back and locks the person who made the change out", async () => {
    const response = await POST(request({ token: "undo-token" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, email: "old@example.com", resetSent: true });
    expect(findUniqueMock.mock.calls[0][0].where).toEqual({ undoTokenHash: hashAccountToken("undo-token") });
    expect(claimMock.mock.calls[0][0].where).toMatchObject({
      undoTokenHash: hashAccountToken("undo-token"),
      undoneAt: null,
    });
    expect(claimMock.mock.calls[0][0].where).not.toHaveProperty("undoTurnedOffAt");
    const update = userUpdateManyMock.mock.calls[0][0];
    // Only while the account still signs in with the address this change set.
    expect(update.where).toEqual({ id: "user-1", email: "new@example.com" });
    // Review 2: the changer's password stops working, every session ends.
    expect(update.data).toMatchObject({
      email: "old@example.com",
      passwordHash: null,
      googleLinkedAt: null,
      sessionVersion: { increment: 1 },
    });
    expect(accountTokenDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
    expect(requestDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
  });

  it("emails a fresh password-reset link to the restored address", async () => {
    await POST(request({ token: "undo-token" }));
    expect(issueAccountTokenMock.mock.calls[0].slice(1, 3)).toEqual(["user-1", "password_reset"]);
    const [to, email] = deliverAccountEmailMock.mock.calls[0];
    expect(to).toBe("old@example.com");
    expect(email.text).toContain("https://app.example.com/reset-password#raw-reset-token");
  });

  it("still answers success, and says so, when the reset email could not be sent", async () => {
    deliverAccountEmailMock.mockResolvedValue(false);
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, email: "old@example.com", resetSent: false });
  });

  // Review 2 item 2: Stripe runs after the answer is sent.
  it("passes the change back to Stripe only after the response", async () => {
    await POST(request({ token: "undo-token" }));
    expect(followMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0][0]();
    expect(followMock).toHaveBeenCalledWith({ userId: "user-1", from: "new@example.com", to: "old@example.com" });
  });

  it("works once: a used link is refused and changes nothing", async () => {
    findUniqueMock.mockResolvedValue(record({ undoneAt: new Date(NOW - 1000) }));
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      // R29 OO1 (security L1): the undo cleared the password and sent a reset link.
      // Lead follow-up: the reset email may have failed, so the answer doesn't claim it went.
      error: "This link was already used, so the change was undone. If you haven't set a new password since, use Reset your password.",
      // Lead review (R28 NN2): the page titles it "already used", not "wasn't undone".
      used: true,
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it("works once under a race: the second claim changes nothing", async () => {
    claimMock.mockResolvedValue({ count: 0 });
    expect((await POST(request({ token: "undo-token" }))).status).toBe(400);
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it("is refused after the email changed again", async () => {
    findUniqueMock.mockResolvedValue(record({ user: { email: "third@example.com" } }));
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: `The sign-in email has changed again since this email was sent, so this link can't undo it. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`,
    });
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it("is refused when the email changed again between the read and the write", async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(409);
    expect(afterMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("is refused when expired, unknown or missing", async () => {
    findUniqueMock.mockResolvedValue(record({ undoExpiresAt: new Date(NOW - 1000) }));
    let response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `This link has expired: it worked for 72 hours. Write to ${SUPPORT_EMAIL} and we'll help you get the account back.`,
    });
    // R6-pages L6: once the window has passed the link's record is cleared,
    // so an unknown link may be an expired one; the answer covers both.
    findUniqueMock.mockResolvedValue(null);
    response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      // R29 OO1 (security L2): the row may be gone after a successful undo, so no "wasn't undone".
      error: `This link has expired or was already used: undo links work for 72 hours. If you already undid the change, sign in with your old address (reset your password if it doesn't work). If not, write to ${SUPPORT_EMAIL} and we'll help you get the account back.`,
      reason: "not_valid",
    });
    response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(userUpdateManyMock).not.toHaveBeenCalled();
  });

  it("says so when another account took the previous address meanwhile", async () => {
    userUpdateManyMock.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const response = await POST(request({ token: "undo-token" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain(
      "Another Vibe Socials account now signs in with your previous address",
    );
  });

  it("answers 400 Invalid JSON body for a body that isn't an object", async () => {
    const response = await POST(
      new Request("http://localhost/api/auth/change-email/undo", { method: "POST", body: "[1]" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});

describe("EmailChangeRequest migration", () => {
  it("has no turn-off column", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(__dirname, "../../../../../../prisma/migrations/20261114550000_email_change_request/migration.sql"),
      "utf8",
    );
    expect(sql).toContain('"undoTokenHash" TEXT');
    expect(sql).not.toContain("undoTurnedOffAt");
  });
});
