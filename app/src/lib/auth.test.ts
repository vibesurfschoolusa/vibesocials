import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckRateLimitOptions, RateLimitResult } from "./rateLimit";

const {
  findUniqueMock,
  checkRateLimitMock,
  compareMock,
  findOrCreateGoogleSsoUserMock,
  getServerSessionMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  compareMock: vi.fn(),
  findOrCreateGoogleSsoUserMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));

// getCurrentUser's session lookup. The real next-auth module is otherwise kept.
vi.mock("next-auth", async () => {
  const actual = await vi.importActual<typeof import("next-auth")>("next-auth");
  return { ...actual, getServerSession: getServerSessionMock };
});

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

import type { NextAuthOptions } from "next-auth";

import {
  authOptions,
  authorizeCredentials,
  getCurrentUser,
  LOGIN_DUMMY_PASSWORD_HASH,
  serverSessionAuthOptions,
} from "./auth";
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
  getServerSessionMock.mockReset();
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

// 2026-11-01 scale audit (W3): getCurrentUser used to pay for the jwt
// callback's sessionVersion lookup AND its own full-row lookup on every
// request. It already compares sessionVersion against the row it loads, so it
// now reads the session with serverSessionAuthOptions (jwt callback without
// the DB check) and issues exactly one user query.
describe("serverSessionAuthOptions.callbacks.jwt — no DB check on token reads", () => {
  type JwtArgs = Parameters<NonNullable<NonNullable<NextAuthOptions["callbacks"]>["jwt"]>>[0];
  const serverJwt = (args: Partial<JwtArgs>) =>
    serverSessionAuthOptions.callbacks!.jwt!(args as JwtArgs);
  const routeJwt = (args: Partial<JwtArgs>) => authOptions.callbacks!.jwt!(args as JwtArgs);

  it("returns the token untouched without querying prisma", async () => {
    const token = { id: "u1", sessionVersion: 0 };

    expect(await serverJwt({ token })).toBe(token);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("keeps the token even when the DB would say the session is revoked (getCurrentUser enforces that)", async () => {
    findUniqueMock.mockResolvedValue({ sessionVersion: 9 });

    expect(await serverJwt({ token: { id: "u1", sessionVersion: 0 } })).toEqual({
      id: "u1",
      sessionVersion: 0,
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("still stamps id + sessionVersion on sign-in (user present), without a DB read", async () => {
    const token = await serverJwt({
      token: {},
      user: { id: "u1", sessionVersion: 4 } as JwtArgs["user"],
    });

    expect(token).toEqual({ id: "u1", sessionVersion: 4 });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("defaults sessionVersion to 0 on sign-in when the user carries none", async () => {
    expect(await serverJwt({ token: {}, user: { id: "u1" } as JwtArgs["user"] })).toEqual({
      id: "u1",
      sessionVersion: 0,
    });
  });

  it("is otherwise identical to authOptions: same session config, pages, providers and other callbacks", () => {
    expect(serverSessionAuthOptions.session).toBe(authOptions.session);
    expect(serverSessionAuthOptions.pages).toBe(authOptions.pages);
    expect(serverSessionAuthOptions.providers).toBe(authOptions.providers);
    expect(serverSessionAuthOptions.secret).toBe(authOptions.secret);
    expect(serverSessionAuthOptions.cookies).toBe(authOptions.cookies);
    expect(serverSessionAuthOptions.callbacks!.session).toBe(authOptions.callbacks!.session);
    expect(serverSessionAuthOptions.callbacks!.signIn).toBe(authOptions.callbacks!.signIn);
    expect(serverSessionAuthOptions.callbacks!.jwt).not.toBe(authOptions.callbacks!.jwt);
  });

  it("authOptions.callbacks.jwt (the /api/auth/session route handler) still re-checks sessionVersion", async () => {
    findUniqueMock.mockResolvedValue({ sessionVersion: 0 });
    const token = { id: "u1", sessionVersion: 0 };
    expect(await routeJwt({ token })).toBe(token);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { sessionVersion: true },
    });

    // Password reset elsewhere bumped the DB value -> null clears the cookie.
    findUniqueMock.mockResolvedValue({ sessionVersion: 1 });
    expect(await routeJwt({ token: { id: "u1", sessionVersion: 0 } })).toBeNull();

    // Deleted user -> null too.
    findUniqueMock.mockResolvedValue(null);
    expect(await routeJwt({ token: { id: "u1", sessionVersion: 0 } })).toBeNull();
  });
});

describe("getCurrentUser", () => {
  const SESSION = {
    user: { id: "u1", sessionVersion: 3 },
    expires: "2999-01-01T00:00:00.000Z",
  };

  it("reads the session with serverSessionAuthOptions (not authOptions)", async () => {
    getServerSessionMock.mockResolvedValue(SESSION);
    findUniqueMock.mockResolvedValue(USER);

    await getCurrentUser();

    expect(getServerSessionMock).toHaveBeenCalledTimes(1);
    expect(getServerSessionMock.mock.calls[0][0]).toBe(serverSessionAuthOptions);
    expect(getServerSessionMock.mock.calls[0][0]).not.toBe(authOptions);
  });

  it("issues exactly one prisma.user.findUnique and returns the full row", async () => {
    getServerSessionMock.mockResolvedValue(SESSION);
    findUniqueMock.mockResolvedValue(USER);

    expect(await getCurrentUser()).toBe(USER);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("returns null without any query when there is no session", async () => {
    getServerSessionMock.mockResolvedValue(null);

    expect(await getCurrentUser()).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("returns null when the user row is gone", async () => {
    getServerSessionMock.mockResolvedValue(SESSION);
    findUniqueMock.mockResolvedValue(null);

    expect(await getCurrentUser()).toBeNull();
  });

  it("returns null when the DB sessionVersion no longer matches the session's (password reset elsewhere)", async () => {
    getServerSessionMock.mockResolvedValue(SESSION);
    findUniqueMock.mockResolvedValue({ ...USER, sessionVersion: 4 });

    expect(await getCurrentUser()).toBeNull();
  });

  describe("revocation end-to-end through the options' real callbacks", () => {
    // Stand-in for getServerSession(options): take a fixed (stale) decoded
    // token, run options.callbacks.jwt then options.callbacks.session, like
    // NextAuth v4 does — so the REAL callbacks of whatever options
    // getCurrentUser passes are what shape the session it sees.
    function installRealSessionPipeline(token: { id: string; sessionVersion: number }) {
      getServerSessionMock.mockImplementation(async (options: NextAuthOptions) => {
        const jwt = await options.callbacks!.jwt!({ token: { ...token } } as never);
        if (!jwt) return null;
        return options.callbacks!.session!({
          session: { user: {}, expires: "2999-01-01T00:00:00.000Z" },
          token: jwt,
        } as never);
      });
    }

    it("a token issued before a password reset (sessionVersion 0) is rejected once the DB says 1", async () => {
      installRealSessionPipeline({ id: "u1", sessionVersion: 0 });
      findUniqueMock.mockResolvedValue({ ...USER, sessionVersion: 1 });

      expect(await getCurrentUser()).toBeNull();
      // One query total: the full-row lookup. The jwt callback added none.
      expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it("a token whose sessionVersion still matches the DB is accepted with a single query", async () => {
      installRealSessionPipeline({ id: "u1", sessionVersion: 3 });
      findUniqueMock.mockResolvedValue(USER);

      expect(await getCurrentUser()).toBe(USER);
      expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });
  });
});
