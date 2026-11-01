import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckRateLimitOptions, RateLimitResult } from "./rateLimit";

const { findUniqueMock, checkRateLimitMock, compareMock, findOrCreateGoogleSsoUserMock } =
  vi.hoisted(() => ({
    findUniqueMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    compareMock: vi.fn(),
    findOrCreateGoogleSsoUserMock: vi.fn(),
  }));

vi.mock("./db", () => ({
  prisma: { user: { findUnique: findUniqueMock } },
}));

vi.mock("./rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

// The Google provider stays unregistered (no env); the signIn callback is
// exercised directly with a mocked resolver.
vi.mock("./googleSso", () => ({
  googleSsoConfig: () => null,
  findOrCreateGoogleSsoUser: findOrCreateGoogleSsoUserMock,
}));

vi.mock("bcryptjs", () => ({
  default: { compare: compareMock },
}));

import { authOptions, authorizeCredentials, LOGIN_DUMMY_PASSWORD_HASH } from "./auth";
import { GOOGLE_PASSWORD_ACCOUNT_ERROR } from "./loginOAuthError";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

function reqFrom(ip: string) {
  return { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } };
}

/**
 * In-memory stand-in for the DB-backed limiter: one counter per
 * `userId + route` (a single window — the tests run inside one bucket).
 */
function installFakeLimiter() {
  const counts = new Map<string, number>();
  checkRateLimitMock.mockImplementation(
    async (opts: CheckRateLimitOptions): Promise<RateLimitResult> => {
      const key = `${opts.userId}|${opts.route}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count > opts.limit ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
    },
  );
}

const USER = {
  id: "u1",
  email: "victim@example.com",
  name: "Victim",
  passwordHash: "$2b$10$realhashrealhashrealhashrealhashrealhashrealhashrealh",
  sessionVersion: 3,
};

beforeEach(() => {
  findUniqueMock.mockReset();
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  compareMock.mockReset();
  compareMock.mockResolvedValue(false);
});

describe("authorizeCredentials — no account-existence timing oracle", () => {
  it("still runs bcrypt.compare (against the fixed dummy hash) when the email has no account", async () => {
    findUniqueMock.mockResolvedValue(null);

    const result = await authorizeCredentials(
      { email: "nobody@example.com", password: "guess" },
      reqFrom("1.1.1.1"),
    );

    expect(result).toBeNull();
    expect(compareMock).toHaveBeenCalledTimes(1);
    expect(compareMock).toHaveBeenCalledWith("guess", LOGIN_DUMMY_PASSWORD_HASH);
  });

  it("still runs bcrypt.compare (against the fixed dummy hash) for a passwordless (SSO-only) account", async () => {
    findUniqueMock.mockResolvedValue({ ...USER, passwordHash: null });

    const result = await authorizeCredentials(
      { email: USER.email, password: "guess" },
      reqFrom("1.1.1.1"),
    );

    expect(result).toBeNull();
    expect(compareMock).toHaveBeenCalledTimes(1);
    expect(compareMock).toHaveBeenCalledWith("guess", LOGIN_DUMMY_PASSWORD_HASH);
  });

  it("the dummy hash is a real bcrypt hash at the same cost (10) the register/reset routes use", async () => {
    const realBcrypt = (await vi.importActual<{ default: typeof import("bcryptjs") }>("bcryptjs"))
      .default;
    expect(realBcrypt.getRounds(LOGIN_DUMMY_PASSWORD_HASH)).toBe(10);
  });

  it("compares against the user's own hash and returns the session user on a match", async () => {
    findUniqueMock.mockResolvedValue(USER);
    compareMock.mockResolvedValue(true);

    const result = await authorizeCredentials(
      { email: "  Victim@Example.COM ", password: "right" },
      reqFrom("1.1.1.1"),
    );

    expect(findUniqueMock).toHaveBeenCalledWith({ where: { email: "victim@example.com" } });
    expect(compareMock).toHaveBeenCalledWith("right", USER.passwordHash);
    expect(result).toEqual({
      id: "u1",
      email: "victim@example.com",
      name: "Victim",
      sessionVersion: 3,
    });
  });

  it("returns null on a wrong password", async () => {
    findUniqueMock.mockResolvedValue(USER);
    compareMock.mockResolvedValue(false);

    expect(
      await authorizeCredentials({ email: USER.email, password: "wrong" }, reqFrom("1.1.1.1")),
    ).toBeNull();
  });

  it("returns null without any lookup when email or password is missing", async () => {
    expect(await authorizeCredentials({ email: "", password: "x" }, reqFrom("1.1.1.1"))).toBeNull();
    expect(await authorizeCredentials(undefined, reqFrom("1.1.1.1"))).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("authorizeCredentials — rate limits", () => {
  it("checks per-(email, IP) 10/15min, per-IP 30/15min and a per-email 100/hour backstop, all fail-closed", async () => {
    findUniqueMock.mockResolvedValue(null);

    await authorizeCredentials(
      { email: "Victim@Example.com", password: "x" },
      reqFrom("203.0.113.7"),
    );

    const calls = checkRateLimitMock.mock.calls.map((c) => c[0] as CheckRateLimitOptions);
    expect(calls).toEqual([
      {
        userId: "email-ip:victim@example.com|203.0.113.7",
        route: "auth/login",
        limit: 10,
        windowMs: FIFTEEN_MINUTES,
        failClosed: true,
      },
      {
        userId: "ip:203.0.113.7",
        route: "auth/login-ip",
        limit: 30,
        windowMs: FIFTEEN_MINUTES,
        failClosed: true,
      },
      {
        userId: "email:victim@example.com",
        route: "auth/login-email",
        limit: 100,
        windowMs: ONE_HOUR,
        failClosed: true,
      },
    ]);
  });

  it.each([0, 1, 2])(
    "returns null — before any user lookup — when limit #%i denies (fail-closed store errors deny too)",
    async (deniedIndex) => {
      let call = 0;
      checkRateLimitMock.mockImplementation(async () =>
        call++ === deniedIndex ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true },
      );
      findUniqueMock.mockResolvedValue(USER);
      compareMock.mockResolvedValue(true);

      expect(
        await authorizeCredentials({ email: USER.email, password: "right" }, reqFrom("1.1.1.1")),
      ).toBeNull();
      expect(findUniqueMock).not.toHaveBeenCalled();
    },
  );

  it("one IP hammering a victim's email can no longer lock the victim out from their own IP", async () => {
    installFakeLimiter();
    findUniqueMock.mockResolvedValue(USER);
    compareMock.mockImplementation(async (password: string) => password === "right");

    for (let i = 0; i < 25; i++) {
      await authorizeCredentials({ email: USER.email, password: `guess-${i}` }, reqFrom("6.6.6.6"));
    }
    // The attacker's own (email, IP) bucket is exhausted...
    compareMock.mockClear();
    expect(
      await authorizeCredentials({ email: USER.email, password: "right" }, reqFrom("6.6.6.6")),
    ).toBeNull();
    expect(compareMock).not.toHaveBeenCalled();

    // ...but the victim, from their own IP, still signs in.
    expect(
      await authorizeCredentials({ email: USER.email, password: "right" }, reqFrom("1.2.3.4")),
    ).toMatchObject({ id: "u1" });
  });

  it("the per-email backstop stops a distributed attack after 100 attempts in the hour", async () => {
    installFakeLimiter();
    findUniqueMock.mockResolvedValue(USER);
    compareMock.mockImplementation(async (password: string) => password === "right");

    // 10 IPs x 10 attempts = 100 attempts that each pass the per-(email, IP)
    // and per-IP limits and count toward the backstop.
    for (let ip = 0; ip < 10; ip++) {
      for (let i = 0; i < 10; i++) {
        await authorizeCredentials(
          { email: USER.email, password: `guess-${i}` },
          reqFrom(`198.51.100.${ip}`),
        );
      }
    }

    expect(
      await authorizeCredentials({ email: USER.email, password: "right" }, reqFrom("1.2.3.4")),
    ).toBeNull();
  });
});

describe("authOptions.callbacks.signIn — Google SSO refusals", () => {
  type SignInArgs = Parameters<NonNullable<typeof authOptions.callbacks>["signIn"] & object>[0];
  const signIn = (args: Partial<SignInArgs>) =>
    authOptions.callbacks!.signIn!(args as SignInArgs);
  const google = { provider: "google", type: "oauth", providerAccountId: "g-1" } as const;
  const profile = { email: "a@b.co", name: "A", email_verified: true };

  beforeEach(() => {
    findOrCreateGoogleSsoUserMock.mockReset();
  });

  it("passes credentials sign-ins straight through", async () => {
    expect(await signIn({ user: { id: "u1" }, account: null })).toBe(true);
    expect(findOrCreateGoogleSsoUserMock).not.toHaveBeenCalled();
  });

  it("redirects a refused password-account link to the login page's specific copy", async () => {
    findOrCreateGoogleSsoUserMock.mockResolvedValue({ ok: false, reason: "password_account" });

    const result = await signIn({ user: { id: "google-sub" }, account: google, profile });

    expect(result).toBe(`/login?error=${GOOGLE_PASSWORD_ACCOUNT_ERROR}`);
    expect(findOrCreateGoogleSsoUserMock).toHaveBeenCalledWith({
      email: "a@b.co",
      name: "A",
      emailVerified: true,
    });
  });

  it("refuses an unverified Google email with plain false (generic AccessDenied copy)", async () => {
    findOrCreateGoogleSsoUserMock.mockResolvedValue({ ok: false, reason: "unverified_email" });

    expect(await signIn({ user: { id: "google-sub" }, account: google, profile })).toBe(false);
  });

  it("stamps OUR user id + sessionVersion onto the NextAuth user on success", async () => {
    findOrCreateGoogleSsoUserMock.mockResolvedValue({
      ok: true,
      user: { id: "db-user", sessionVersion: 4 },
    });
    const user = { id: "google-sub" } as { id: string; sessionVersion?: number };

    expect(await signIn({ user, account: google, profile })).toBe(true);
    expect(user).toEqual({ id: "db-user", sessionVersion: 4 });
  });
});
