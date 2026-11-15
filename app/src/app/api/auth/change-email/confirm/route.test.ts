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
} = vi.hoisted(() => ({
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
    user: { email: "old@example.com" },
    ...overrides,
  };
}

const DEAD = "This link has expired or was already used. Your email is unchanged. To change it, ask again in Settings, Account.";

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
  ]) {
    mock.mockReset();
  }
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

  it("answers a plain 400 for a missing, unknown, used or expired link and changes nothing", async () => {
    const cases: Array<[unknown, unknown]> = [
      [{}, record()],
      [{ token: "raw-token" }, null],
      [{ token: "raw-token" }, record({ usedAt: new Date(NOW - 1000) })],
      [{ token: "raw-token" }, record({ expiresAt: new Date(NOW - 1000) })],
    ];
    for (const [body, found] of cases) {
      findUniqueMock.mockResolvedValue(found);
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: DEAD });
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

  it("changes nothing when the link was used in the meantime", async () => {
    claimMock.mockResolvedValue({ count: 0 });
    const response = await POST(request({ token: "raw-token" }));
    expect(response.status).toBe(400);
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
