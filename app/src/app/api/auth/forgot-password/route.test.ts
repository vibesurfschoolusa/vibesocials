import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// invites/[token]/accept/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/rateLimit` and `@/lib/accountEmails` at module scope, so they are
// mocked before route.ts is imported below. `@/lib/accountToken` is REAL, over
// an in-memory token table (R56: which links still work after a send).
// `@/lib/logger` is left REAL (its console sink is spied where a catch path is
// exercised).
const {
  checkRateLimitMock,
  findUniqueUserMock,
  tokenTable,
  buildPasswordResetEmailMock,
  deliverAccountEmailMock,
} = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  tokenTable: { current: null as unknown },
  buildPasswordResetEmailMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: findUniqueUserMock },
    get accountToken() {
      return tokenTable.current;
    },
  },
}));

vi.mock("@/lib/accountEmails", () => ({
  buildPasswordResetEmail: buildPasswordResetEmailMock,
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { hashAccountToken } from "@/lib/accountToken";
import { makeFakeAccountTokenStore } from "@/lib/accountToken.fakeStore";

import { POST } from "./route";

let store: ReturnType<typeof makeFakeAccountTokenStore>;

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
  buildPasswordResetEmailMock.mockReset();
  deliverAccountEmailMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findUniqueUserMock.mockResolvedValue(null);
  store = makeFakeAccountTokenStore();
  tokenTable.current = store.db.accountToken;
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

  // R45 review M1: checked before any limit, so it can't be made slow.
  it("refuses a 10,000-character email within milliseconds, before any limit", async () => {
    for (const email of ["a.@".repeat(3334) + " ", "a".repeat(9_990) + "@example.com"]) {
      const started = performance.now();
      const response = await POST(req({ email }));
      expect(performance.now() - started).toBeLessThan(50);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Enter a valid email address." });
    }
    expect(checkRateLimitMock).not.toHaveBeenCalled();
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
      failClosed: true,
    });
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: expect.stringMatching(/^ip:/),
      route: "auth/forgot-ip",
      limit: 10,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
  });

  it("normalizes the per-email throttle key and looks the user up normalized", async () => {
    findUniqueUserMock.mockResolvedValue(null);

    await POST(req({ email: "User@X.com" }));

    // Case rotation ("User@x.com", "uSer@X.com", ...) must not mint fresh
    // rate-limit buckets for the same mailbox.
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "email:user@x.com",
      route: "auth/forgot",
      limit: 3,
      windowMs: 15 * 60 * 1000,
      failClosed: true,
    });
    // Lookup matches registration/login (normalizeEmail = trim + lowercase).
    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { email: "user@x.com" },
      select: { id: true, email: true },
    });
  });

  it("returns 429 with Retry-After and never reads the db when rate limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(req({ email: "user@x.com" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toEqual({
      error: "Too many tries. Wait a minute, then try again.",
      retryAfterSeconds: 42,
    });
    expect(findUniqueUserMock).not.toHaveBeenCalled();
  });

  it("returns 200 { ok: true } for an UNKNOWN email — no token issued, no email sent", async () => {
    findUniqueUserMock.mockResolvedValue(null);

    const response = await POST(req({ email: "ghost@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(store.rows).toEqual([]);
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });

  it("for a KNOWN email issues a password_reset token and delivers the built email, still 200 { ok: true }", async () => {
    findUniqueUserMock.mockResolvedValue({ id: "user-9", email: "known@x.com" });

    const response = await POST(req({ email: "known@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ userId: "user-9", type: "password_reset" });
    const { rawToken } = buildPasswordResetEmailMock.mock.calls[0][0];
    expect(buildPasswordResetEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "known@x.com" }));
    expect(store.rows[0].tokenHash).toBe(hashAccountToken(rawToken));
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
    tokenTable.current = { create: vi.fn().mockRejectedValue(new Error("db down")), deleteMany: vi.fn() };

    const response = await POST(req({ email: "known@x.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    consoleSpy.mockRestore();
  });

  // R56 new-customer L1, pages-a L4: the earlier link is retired only once the
  // new one's email is accepted, and none of it reaches the answer.
  describe("which link works after a request", () => {
    const OLD = hashAccountToken("earlier-link");
    const known = { id: "user-1", email: "known@x.com" };

    it("delivery accepted: the earlier link is retired and only the new one works", async () => {
      findUniqueUserMock.mockResolvedValue(known);
      store.seed({ userId: "user-1", type: "password_reset", tokenHash: OLD });
      await POST(req({ email: "known@x.com" }));
      const { rawToken } = buildPasswordResetEmailMock.mock.calls[0][0];
      expect(store.hashes()).toEqual([hashAccountToken(rawToken)]);
    });

    it("delivery refused: the earlier link keeps working and the new one is removed", async () => {
      findUniqueUserMock.mockResolvedValue(known);
      deliverAccountEmailMock.mockResolvedValue(false);
      store.seed({ userId: "user-1", type: "password_reset", tokenHash: OLD });
      await POST(req({ email: "known@x.com" }));
      expect(store.hashes()).toEqual([OLD]);
    });

    it("two requests in a row, both accepted: only the newest link works", async () => {
      findUniqueUserMock.mockResolvedValue(known);
      await POST(req({ email: "known@x.com" }));
      await POST(req({ email: "known@x.com" }));
      const newest = buildPasswordResetEmailMock.mock.calls[1][0].rawToken;
      expect(store.hashes()).toEqual([hashAccountToken(newest)]);
    });

    it("a used link is never deleted", async () => {
      findUniqueUserMock.mockResolvedValue(known);
      const usedAt = new Date("2026-11-19T00:00:00.000Z");
      store.seed({ userId: "user-1", type: "password_reset", tokenHash: OLD, usedAt });
      await POST(req({ email: "known@x.com" }));
      expect(store.rows.find((row) => row.tokenHash === OLD)?.usedAt).toEqual(usedAt);
    });

    it("answers byte-identically for an unknown address and a known one, delivery accepted or refused", async () => {
      const answers: string[] = [];
      for (const [user, delivered] of [
        [null, true],
        [known, true],
        [known, false],
      ] as const) {
        findUniqueUserMock.mockResolvedValueOnce(user);
        deliverAccountEmailMock.mockResolvedValueOnce(delivered);
        const response = await POST(req({ email: user ? "known@x.com" : "ghost@x.com" }));
        answers.push(`${response.status} ${response.headers.get("content-type")} ${await response.text()}`);
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toBe('200 application/json {"ok":true}');
    });
  });
});
