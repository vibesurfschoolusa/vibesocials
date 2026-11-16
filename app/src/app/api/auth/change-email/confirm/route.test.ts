import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashAccountToken } from "@/lib/accountToken";

// R5 new-customer L4: following the link sent to the new address makes the change.
const {
  checkRateLimitMock,
  findUniqueMock,
  claimMock,
  userUpdateMock,
  accountTokenDeleteManyMock,
  requestDeleteManyMock,
  deliverAccountEmailMock,
  getCurrentUserMock,
  followMock,
  afterMock,
  accountUndoWindowUntilMock,
  addressHeldUntilMock,
} = vi.hoisted(() => ({
  accountUndoWindowUntilMock: vi.fn(),
  addressHeldUntilMock: vi.fn(),
  afterMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  followMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueMock: vi.fn(),
  claimMock: vi.fn(),
  userUpdateMock: vi.fn(),
  accountTokenDeleteManyMock: vi.fn(),
  requestDeleteManyMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/server/billing/customerEmail", () => ({ followEmailChangeInStripe: followMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/server/auth/undoWindow", () => ({
  accountUndoWindowUntil: accountUndoWindowUntilMock,
  addressHeldUntil: addressHeldUntilMock,
}));
vi.mock("@/lib/db", () => {
  const tx = {
    emailChangeRequest: { updateMany: claimMock, deleteMany: requestDeleteManyMock },
    user: { update: userUpdateMock },
    accountToken: { deleteMany: accountTokenDeleteManyMock },
  };
  return {
    prisma: {
      emailChangeRequest: { findUnique: findUniqueMock },
      $transaction: (cb: (t: unknown) => unknown) => cb(tx),
    },
  };
});
vi.mock("@/lib/accountEmails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accountEmails")>()),
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

const NOW = Date.now();

function request(body: unknown): Request {
  return new Request("http://localhost/api/auth/change-email/confirm", {
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
    tokenHash: hashAccountToken("raw-token"),
    expiresAt: new Date(NOW + 60_000),
    usedAt: null,
    user: { email: "old@example.com", emailVerifiedAt: new Date(NOW - 86_400_000), googleLinkedAt: null },
    ...overrides,
  };
}

const USED = "This link was already used. If you just confirmed it, your email has changed.";
// R29 OO1 (security L2): the row may be gone after a confirmed change, so no "unchanged".
const DEAD =
  "This link has expired or was already used. If you already confirmed the change, sign in with the new address. If not, ask for the change again in Settings, Account.";

beforeEach(() => {
  for (const mock of [
    checkRateLimitMock,
    findUniqueMock,
    claimMock,
    userUpdateMock,
    accountTokenDeleteManyMock,
    requestDeleteManyMock,
    deliverAccountEmailMock,
    getCurrentUserMock,
    followMock,
    afterMock,
    accountUndoWindowUntilMock,
    addressHeldUntilMock,
  ]) {
    mock.mockReset();
  }
  accountUndoWindowUntilMock.mockResolvedValue(null);
  addressHeldUntilMock.mockResolvedValue(null);
  afterMock.mockImplementation(() => undefined);
  getCurrentUserMock.mockResolvedValue(null);
  followMock.mockResolvedValue(undefined);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findUniqueMock.mockResolvedValue(record());
  claimMock.mockResolvedValue({ count: 1 });
  userUpdateMock.mockResolvedValue({});
  accountTokenDeleteManyMock.mockResolvedValue({ count: 0 });
  requestDeleteManyMock.mockResolvedValue({ count: 0 });
  deliverAccountEmailMock.mockResolvedValue(true);
});

describe("POST /api/auth/change-email/confirm", () => {
  it("is rate limited by network and fails closed", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await POST(request({ token: "raw-token" }))).status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ip:203.0.113.9", route: "auth/change-email-confirm", failClosed: true }),
    );
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("answers a plain 400 for a missing, unknown or expired link and changes nothing", async () => {
    const cases: Array<[unknown, unknown]> = [
      [{}, record()],
      [{ token: "raw-token" }, null],
      [{ token: "raw-token" }, record({ expiresAt: new Date(NOW - 1000) })],
    ];
    for (const [body, found] of cases) {
      findUniqueMock.mockResolvedValue(found);
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: DEAD, reason: "not_valid" });
    }
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("changes the email, marks it verified, signs out every session and drops old account links", async () => {
    const response = await POST(request({ token: "raw-token" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, viewer: "signed_out", email: "new@example.com" });
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashAccountToken("raw-token") } }),
    );
    expect(claimMock.mock.calls[0][0].where).toMatchObject({ tokenHash: hashAccountToken("raw-token"), usedAt: null });
    // Review: the claim also stores what an undo needs.
    const claimed = claimMock.mock.calls[0][0].data;
    expect(claimed.usedAt).toBeInstanceOf(Date);
    expect(claimed.previousEmail).toBe("old@example.com");
    expect(claimed.undoTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const undoTtl = claimed.undoExpiresAt.getTime() - claimed.usedAt.getTime();
    expect(undoTtl).toBe(72 * 60 * 60 * 1000);
    const update = userUpdateMock.mock.calls[0][0];
    expect(update.where).toEqual({ id: "user-1" });
    expect(update.data).toMatchObject({
      email: "new@example.com",
      googleLinkedAt: null,
      sessionVersion: { increment: 1 },
    });
    expect(update.data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(accountTokenDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
    expect(requestDeleteManyMock).toHaveBeenCalledWith({ where: { userId: "user-1", usedAt: null } });
  });

  it("tells the old address about the change, with an undo link whose token matches the stored hash", async () => {
    await POST(request({ token: "raw-token" }));
    const [to, email] = deliverAccountEmailMock.mock.calls[0];
    expect(to).toBe("old@example.com");
    expect(email.text).toContain("new@example.com");
    const raw = /\/verify-email\/undo#([A-Za-z0-9_-]+)/.exec(email.text)?.[1];
    expect(raw).toBeTruthy();
    expect(hashAccountToken(raw!)).toBe(claimMock.mock.calls[0][0].data.undoTokenHash);
  });

  // R7-new-customer H1: a mistyped sign-up address fixed with Change email
  // must not let that mailbox's owner take the account with an undo link.
  describe("from an address that was never confirmed", () => {
    const unconfirmed = () =>
      record({ user: { email: "old@example.com", emailVerifiedAt: null, googleLinkedAt: null } });

    it("makes the change but opens no undo window and keeps no previous address", async () => {
      findUniqueMock.mockResolvedValue(unconfirmed());
      const response = await POST(request({ token: "raw-token" }));
      expect(response.status).toBe(200);
      const claimed = claimMock.mock.calls[0][0].data;
      expect(claimed.usedAt).toBeInstanceOf(Date);
      expect(claimed.previousEmailUnverified).toBe(true);
      // No window: the account can change its email again and be deleted at once.
      expect(claimed).not.toHaveProperty("undoExpiresAt");
      expect(claimed).not.toHaveProperty("undoTokenHash");
      expect(claimed).not.toHaveProperty("previousEmail");
      expect(userUpdateMock.mock.calls[0][0].data).toMatchObject({ email: "new@example.com" });
    });

    it("sends the unconfirmed address no undo link and no notice naming the new address", async () => {
      findUniqueMock.mockResolvedValue(unconfirmed());
      await POST(request({ token: "raw-token" }));
      expect(deliverAccountEmailMock).not.toHaveBeenCalled();
    });

    it("still passes the change on to Stripe", async () => {
      findUniqueMock.mockResolvedValue(unconfirmed());
      await POST(request({ token: "raw-token" }));
      await afterMock.mock.calls[0][0]();
      expect(followMock).toHaveBeenCalledWith({ userId: "user-1", from: "old@example.com", to: "new@example.com" });
    });

    it("counts an account linked to Google as confirmed, as everywhere else", async () => {
      findUniqueMock.mockResolvedValue(
        record({ user: { email: "old@example.com", emailVerifiedAt: null, googleLinkedAt: new Date(NOW - 1000) } }),
      );
      await POST(request({ token: "raw-token" }));
      const claimed = claimMock.mock.calls[0][0].data;
      expect(claimed.previousEmail).toBe("old@example.com");
      expect(claimed.undoExpiresAt).toBeInstanceOf(Date);
      expect(claimed).not.toHaveProperty("previousEmailUnverified");
      expect(deliverAccountEmailMock).toHaveBeenCalledTimes(1);
    });

    it("reads whether the previous address was confirmed with the request", async () => {
      await POST(request({ token: "raw-token" }));
      expect(findUniqueMock.mock.calls[0][0].include).toEqual({
        user: { select: { email: true, emailVerifiedAt: true, googleLinkedAt: true } },
      });
    });
  });

  // Review item 5: Stripe follows, best effort, after the answer is sent.
  it("passes the change on to the Stripe customers after the response", async () => {
    await POST(request({ token: "raw-token" }));
    expect(followMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0][0]();
    expect(followMock).toHaveBeenCalledWith({ userId: "user-1", from: "old@example.com", to: "new@example.com" });
  });

  it("answers success at once while Stripe hangs", async () => {
    followMock.mockImplementation(() => new Promise(() => {}));
    // Run the deferred work right away, as a platform would once the answer
    // is out, and do not wait for it: the answer must not depend on it.
    afterMock.mockImplementation((task: () => unknown) => {
      void task();
    });
    const started = Date.now();
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(followMock).toHaveBeenCalledTimes(1);
  });

  it("still answers success when the Stripe update fails", async () => {
    followMock.mockRejectedValue(new Error("Stripe down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    afterMock.mockImplementation((task: () => unknown) => {
      void task();
    });
    expect((await POST(request({ token: "raw-token" }))).status).toBe(200);
  });

  // Review item 2: the page signs out only the account that changed.
  it("says whether the browser is signed in to the account that changed", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1" });
    await expect((await POST(request({ token: "raw-token" }))).json()).resolves.toEqual({
      ok: true,
      viewer: "this_account",
      email: "new@example.com",
    });

    findUniqueMock.mockResolvedValue(record());
    getCurrentUserMock.mockResolvedValue({ id: "someone-else" });
    await expect((await POST(request({ token: "raw-token" }))).json()).resolves.toEqual({
      ok: true,
      viewer: "other_account",
    });
  });

  // R6-pages L1: a used link opened again answers about the link, not "unchanged".
  it("says a used link was already used, and that the email has changed if this person used it", async () => {
    findUniqueMock.mockResolvedValue(record({ usedAt: new Date(NOW - 1000) }));
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: USED, used: true });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("changes nothing when the link was used in the meantime, and says it was used", async () => {
    claimMock.mockResolvedValue({ count: 0 });
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: USED, used: true });
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("says so when another account took the address meanwhile", async () => {
    userUpdateMock.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Another Vibe Socials account now signs in with this address, so your email is unchanged.",
    });
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  // R6-security M1: an open undo window keeps the previous address free for it.
  it("refuses an address another account's undo may still put back, and changes nothing", async () => {
    addressHeldUntilMock.mockResolvedValue(new Date("2026-11-17T12:00:00.000Z"));
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "This address was another Vibe Socials account's sign-in email until recently, and that account can take it back until November 17, 2026, so your email is unchanged. After that, ask for the change again in Settings, Account.",
      reason: "held",
      until: "2026-11-17T12:00:00.000Z",
    });
    expect(addressHeldUntilMock).toHaveBeenCalledWith(expect.anything(), "new@example.com", expect.any(Date));
    expect(claimMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("refuses while this account's last change can still be undone, and changes nothing", async () => {
    const until = new Date("2026-11-17T12:00:00.000Z");
    accountUndoWindowUntilMock.mockResolvedValue(until);
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You changed your email recently; you can change it again after November 17, 2026.",
      reason: "locked",
      until: until.toISOString(),
    });
    expect(accountUndoWindowUntilMock).toHaveBeenCalledWith(expect.anything(), "user-1", expect.any(Date));
    expect(claimMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("answers 400 Invalid JSON body for a body that isn't an object", async () => {
    for (const raw of ["null", "[1]", "{not json"]) {
      const response = await POST(
        new Request("http://localhost/api/auth/change-email/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    }
  });
});
