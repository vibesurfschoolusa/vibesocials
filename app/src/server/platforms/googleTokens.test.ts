import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_TOKEN_EXPIRY_BUFFER_MS,
  googleTokenExpiresSoon,
  refreshGoogleToken,
  refreshGoogleTokenEarly,
} from "@/server/platforms/googleTokens";
import { DEFAULT_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;
import { MIN_REQUEST_WINDOW_MS, PUBLISH_BUDGET_EXCEEDED_CODE } from "@/server/platforms/publishBudget";

// vi.mock + vi.hoisted are hoisted above imports by vitest; refreshGoogleToken
// resolves prisma via `await import("@/lib/db")` at call time, so it receives
// this mock. No real database is touched.
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
      // The guarded reconnect flag re-reads the stored tokens (connectionHealth.ts).
      findUnique: findUniqueMock,
    },
  },
}));

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "youtube",
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: null,
    metadata: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    reconnectEmailedAt: null,
    expiryWarnedFor: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockImplementation(
    (args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...makeConnection(), ...args.data }),
  );
  // By default the database still holds the tokens makeConnection() builds, so
  // the guarded flag finds them unchanged and writes.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
  });
  vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refreshGoogleToken", () => {
  it("updates ONLY accessToken and expiresAt, never refreshToken, and computes expiry", async () => {
    const expiresIn = 3600;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        tokenResponse({
          access_token: "new-access-token",
          expires_in: expiresIn,
          token_type: "Bearer",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-42", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshGoogleToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };

    expect(arg.where).toEqual({ id: "conn-42" });

    // The success write persists the new token + expiry and clears the
    // reconnect-health flags. THE program-level constraint: it must NEVER touch
    // refreshToken (or metadata).
    expect(Object.keys(arg.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(arg.data.needsReconnect).toBe(false);
    expect(arg.data.accessToken).toBe("new-access-token");

    // Expiry math: now + expires_in seconds.
    const expiresMs = (arg.data.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + expiresIn * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + expiresIn * 1000);
  });

  it("falls back to a 3600s default expiry when expires_in is missing from the token response, and still omits refreshToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "new-access-token",
        token_type: "Bearer",
        // expires_in intentionally omitted.
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-99", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshGoogleToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };

    // Fallback magnitude: pin it to exactly Google's standard 3600s
    // access-token TTL (same before/after bounds pattern as the primary
    // expiry test above), not just "some time in the future".
    const expiresAt = arg.data.expiresAt as Date;
    expect(expiresAt instanceof Date && !isNaN(expiresAt.getTime())).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 3_600_000);
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("throws GOOGLE_NO_REFRESH_TOKEN, never hits the network, and marks needsReconnect (flag fields only, no tokens)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-7", refreshToken: null });
    findUniqueMock.mockResolvedValue({ accessToken: "old-access-token", refreshToken: null });

    const error = await refreshGoogleToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_NO_REFRESH_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();

    // Roadmap Phase 4: the connection-specific "no refresh token" failure IS
    // marked (unlike the env-config failure below) — flag fields only, never
    // accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-7" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("GOOGLE_NO_REFRESH_TOKEN");
    expect(arg.data.refreshFailedAt).toBeInstanceOf(Date);
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("throws GOOGLE_MISSING_OAUTH_CREDENTIALS when client env vars are absent", async () => {
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshGoogleToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_MISSING_OAUTH_CREDENTIALS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws sanitized GOOGLE_TOKEN_REFRESH_FAILED without leaking the upstream body, and marks needsReconnect (flag fields only, no tokens)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = "invalid_grant: token has been expired or revoked SECRET123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-8" });
    const error = await refreshGoogleToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    expect(error?.message).not.toContain(upstreamBody);
    expect(error?.message).toContain("400");
    // Raw upstream body reaches the server logs.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);

    // Roadmap Phase 4: assertOk's non-2xx (the real invalid_grant signal) is
    // the OTHER marked path — flag fields only, never accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-8" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});

// 2026-11-01 audit (Task 4 item 2): only a TERMINAL refresh failure (HTTP
// 400/401, e.g. invalid_grant) flags needsReconnect. A rate limit, a Google
// outage or a network blip must not mark a working connection dead.
describe("refreshGoogleToken — failure classification", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function failWith(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
      ),
    );
  }

  async function refreshError() {
    return refreshGoogleToken(makeConnection({ id: "conn-c" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; status?: number });
  }

  it.each([
    ["429 rate limited", 429, { error: "rate_limit_exceeded" }],
    ["500", 500, "<html>oops</html>"],
    ["503", 503, { error: "backend_error" }],
    ["502 even with invalid_grant in the body", 502, { error: "invalid_grant" }],
    ["401 invalid_client (our OAuth client, not the user's grant)", 401, { error: "invalid_client" }],
  ] as const)("%s: throws the sanitized, status-carrying error WITHOUT flagging", async (_l, status, body) => {
    failWith(status, body);

    const error = await refreshError();

    expect(error?.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    // status is carried so withTransientRetries can retry 429/5xx in-step.
    expect(error?.status).toBe(status);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // F7: the OAuth code rides on the thrown error, so the Reviews page can tell
  // the person's dead grant (reconnect) from our own client's setup (not available).
  // JJ3 lead review: a refresh that flags the row (400 unauthorized_client
  // included) reads as reconnect, so the page and Settings agree.
  it.each([
    ["400 invalid_grant", 400, "invalid_grant", "reconnect"],
    ["400 unauthorized_client", 400, "unauthorized_client", "reconnect"],
    ["401 invalid_client", 401, "invalid_client", "unavailable"],
  ] as const)("%s: carries oauthError, and the Reviews page reads it", async (_l, status, oauthError, shown) => {
    failWith(status, { error: oauthError });
    const { GOOGLE_REFUSED_MESSAGE, GOOGLE_NOT_ANSWERING_MESSAGE, reviewsErrorBody } = await import(
      "@/server/googleReviews"
    );

    const error = await refreshError();

    expect(error).toMatchObject({ code: "GOOGLE_TOKEN_REFRESH_FAILED", status, oauthError });
    // Flagged exactly when it reads as reconnect.
    expect(updateMock.mock.calls.length > 0).toBe(shown === "reconnect");
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual(
      shown === "reconnect"
        ? { error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true }
        : { error: GOOGLE_NOT_ANSWERING_MESSAGE },
    );
  });

  it("carries no oauthError when the body has no OAuth code, and the message is unchanged", async () => {
    failWith(401, "Unauthorized");

    const error = await refreshError();

    expect(error).not.toHaveProperty("oauthError");
    expect(error?.message).toBe("Failed to refresh Google access token (status 401)");
  });

  it.each([
    ["400 invalid_grant", 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }],
    ["401 with an unparseable body", 401, "Unauthorized"],
  ] as const)("%s: flags needsReconnect (flag fields only)", async (_l, status, body) => {
    failWith(status, body);

    const error = await refreshError();

    expect(error?.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "conn-c" });
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("propagates a network failure unchanged and does not flag", async () => {
    const networkError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    const error = await refreshError();

    expect(error).toBe(networkError);
    expect(updateMock).not.toHaveBeenCalled();
  });
});


// 2026-11-01 scale audit (jobs, token refresh): the flag is guarded by the
// tokens this refresh used. If another process refreshed the connection in the
// meantime (stored access token changed), a failure here must not mark the
// working connection dead; the refresher throws TOKEN_REFRESH_SUPERSEDED and
// refreshConnectionToken hands back the stored row.
describe("refreshGoogleToken — superseded by another refresh", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("invalid_grant while the stored access token already changed: throws TOKEN_REFRESH_SUPERSEDED and never writes needsReconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );
    findUniqueMock.mockResolvedValue({
      accessToken: "another-process-access-token",
      refreshToken: "refresh-abc",
    });

    const error = await refreshGoogleToken(makeConnection({ id: "conn-s" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("asks the flag to compare against the tokens the refresh used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );

    await refreshGoogleToken(
      makeConnection({ id: "conn-s", accessToken: "used-access", refreshToken: "used-refresh" }),
    ).catch(() => undefined);

    // Stored tokens differ from the ones used (the default stored row) -> superseded.
    expect(updateMock).not.toHaveBeenCalled();
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "conn-s" },
      select: { accessToken: true, refreshToken: true },
    });
  });

  it("a missing refresh token while the stored tokens changed (a reconnect): superseded, not flagged", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    findUniqueMock.mockResolvedValue({
      accessToken: "reconnected-access-token",
      refreshToken: "reconnected-refresh-token",
    });

    const error = await refreshGoogleToken(makeConnection({ refreshToken: null }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a flag that cannot be persisted ('error') still surfaces the original refresh error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );
    findUniqueMock.mockRejectedValue(new Error("db down"));

    const error = await refreshGoogleToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
  });
});


// 2026-11-01 scale audit (platform limits / step budget, Task 7): a token refresh
// that runs inside a platform step (or inside Task 8's per-connection lock) must
// not push that step past its deadline, so its request timeout is clamped to the
// time left and a request is never started with under 5 s left.
describe("refreshGoogleToken — step deadline", () => {
  const NOW = Date.parse("2026-11-01T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A fresh Response per call: a body can only be read once.
  const okFetch = () =>
    vi.fn(() =>
      Promise.resolve(
        tokenResponse({ access_token: "new-access-token", expires_in: 3600, token_type: "Bearer" }),
      ),
    );

  /** The timeout every fetchWithTimeout call armed (its timer's delay). */
  const requestTimeouts = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => c[1] as number);

  it("clamps the token request's timeout to the time left (a deadline 8 s away -> <= 8 s)", async () => {
    vi.stubGlobal("fetch", okFetch());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await refreshGoogleToken(makeConnection(), { deadline: NOW + 8_000 });

    const timeouts = requestTimeouts(setTimeoutSpy);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
    expect(timeouts[0]).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
  });

  it("keeps the 30 s default when the deadline is far away or absent", async () => {
    vi.stubGlobal("fetch", okFetch());
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await refreshGoogleToken(makeConnection(), { deadline: NOW + 200_000 });
    await refreshGoogleToken(makeConnection());

    expect(requestTimeouts(setTimeoutSpy)).toEqual([30_000, 30_000]);
  });

  it("refuses to start with under 5 s left: PUBLISH_TIME_BUDGET_EXCEEDED, no request, no write, no reconnect flag", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshGoogleToken(makeConnection(), {
      deadline: NOW + MIN_REQUEST_WINDOW_MS - 1,
    }).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// R23 client-journey L1 = platform-clients L1: every Google reader (Reviews
// routes, the review alerts job, the publish clients) refreshes a token in its
// last 5 minutes, judged against the real clock.
describe("googleTokenExpiresSoon", () => {
  const MINUTE = 60 * 1000;

  it("is 5 minutes", () => {
    expect(GOOGLE_TOKEN_EXPIRY_BUFFER_MS).toBe(5 * MINUTE);
  });

  it("is true with 4 minutes left, and for an expired token", () => {
    expect(googleTokenExpiresSoon({ expiresAt: new Date(Date.now() + 4 * MINUTE) })).toBe(true);
    expect(googleTokenExpiresSoon({ expiresAt: new Date(Date.now() - MINUTE) })).toBe(true);
  });

  it("is false with 10 minutes left, and with no stored expiry", () => {
    expect(googleTokenExpiresSoon({ expiresAt: new Date(Date.now() + 10 * MINUTE) })).toBe(false);
    expect(googleTokenExpiresSoon({ expiresAt: null })).toBe(false);
  });

  it("uses the clock now, not a time the caller read earlier", () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T13:00:00Z"), toFake: ["Date"] });
    const expiresAt = new Date("2026-11-10T13:20:00Z");
    expect(googleTokenExpiresSoon({ expiresAt })).toBe(false);
    vi.setSystemTime(new Date("2026-11-10T13:16:00Z"));
    expect(googleTokenExpiresSoon({ expiresAt })).toBe(true);
    vi.useRealTimers();
  });

  it("with mustLastUntil, is true when the token ends before that time", () => {
    const expiresAt = new Date(Date.now() + 10 * MINUTE);
    expect(googleTokenExpiresSoon({ expiresAt }, Date.now() + 20 * MINUTE)).toBe(true);
    expect(googleTokenExpiresSoon({ expiresAt }, Date.now() + 2 * MINUTE)).toBe(false);
  });
});

// Lead review follow-up: an early refresh that fails while the stored token is
// still valid serves the request with the stored token; only an expired token
// fails as today. Every Google reader goes through this.
describe("refreshGoogleTokenEarly", () => {
  const MINUTE = 60 * 1000;
  const refused = () =>
    Object.assign(new Error("Failed to refresh Google access token (status 503)"), {
      code: "GOOGLE_TOKEN_REFRESH_FAILED",
      status: 503,
    });

  it("leaves a token with 10 minutes left alone", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 10 * MINUTE) });
    const refresh = vi.fn();
    await expect(refreshGoogleTokenEarly(connection, refresh)).resolves.toBe(connection);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes a token with 4 minutes left", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 4 * MINUTE) });
    const fresh = makeConnection({ accessToken: "fresh" });
    const refresh = vi.fn().mockResolvedValue(fresh);
    await expect(refreshGoogleTokenEarly(connection, refresh)).resolves.toBe(fresh);
    expect(refresh).toHaveBeenCalledWith(connection);
  });

  it("a failed refresh with 4 minutes left serves the stored token and logs the failure", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 4 * MINUTE) });
    const refresh = vi.fn().mockRejectedValue(refused());

    await expect(refreshGoogleTokenEarly(connection, refresh)).resolves.toBe(connection);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("stored token"),
      expect.objectContaining({ connectionId: "conn-1", code: "GOOGLE_TOKEN_REFRESH_FAILED" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("old-access-token");
  });

  it("a failed refresh after expiry fails as today", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() - MINUTE) });
    const error = refused();
    await expect(refreshGoogleTokenEarly(connection, vi.fn().mockRejectedValue(error))).rejects.toBe(error);
  });

  it("passes mustLastUntil to the check", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 10 * MINUTE) });
    const refresh = vi.fn().mockResolvedValue(connection);
    await refreshGoogleTokenEarly(connection, refresh, { mustLastUntil: Date.now() + 20 * MINUTE });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// Lead review (R23): the stored-token fallback must not hide a dead grant. The
// real refreshGoogleToken still flags the row, and once the stored token has
// expired the caller gets the reconnect outcome.
describe("refreshGoogleTokenEarly with the real refresh and invalid_grant", () => {
  const MINUTE = 60 * 1000;
  const T0 = new Date("2026-11-10T13:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("4 minutes left: serves the stored token and still writes needsReconnect and refreshFailedAt; after expiry: reconnect", async () => {
    const connection = makeConnection({ expiresAt: new Date(T0.getTime() + 4 * MINUTE) });

    await expect(refreshGoogleTokenEarly(connection, (c) => refreshGoogleToken(c))).resolves.toBe(connection);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const { data } = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.needsReconnect).toBe(true);
    expect(data.refreshFailedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("accessToken");
    expect(data).not.toHaveProperty("refreshToken");

    // The stored token runs out: the same call now fails with the reconnect outcome.
    vi.setSystemTime(new Date(T0.getTime() + 5 * MINUTE));
    const error = await refreshGoogleTokenEarly(connection, (c) => refreshGoogleToken(c)).then(
      () => null,
      (e: unknown) => e,
    );
    const { GOOGLE_REFUSED_MESSAGE, reviewsErrorBody } = await import("@/server/googleReviews");
    expect(error).toMatchObject({ code: "GOOGLE_TOKEN_REFRESH_FAILED", oauthError: "invalid_grant" });
    expect(reviewsErrorBody(error, "Fallback.", "owner")).toEqual({ error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true });
  });
});

// R47 platform L1: the token request's limit covers the body too
// (fetchWithinLimit), so a refresh whose headers came and whose body stalls
// ends as FETCH_TIMEOUT instead of hanging the hourly numbers step.
describe("refreshGoogleToken: a stalled body", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stallAfterHeaders(status: number) {
    return (_input: string | URL, init?: RequestInit): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
    };
  }

  async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
    const settled = promise.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(ms);
    return Promise.race([settled, Promise.resolve("still waiting")]);
  }

  it("a 200 whose body never ends rejects with FETCH_TIMEOUT within the limit, and writes nothing", async () => {
    vi.useFakeTimers();
    abortSignalTimeoutOnFakeClock();
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));

    const out = await settleWithin(refreshGoogleToken(makeConnection()), DEFAULT_FETCH_TIMEOUT_MS);

    expect(out).toMatchObject({ code: FETCH_TIMEOUT_CODE });
    expect(updateMock).not.toHaveBeenCalled();
  }, STALL_TEST_TIMEOUT_MS);

  it("an error body that never ends is bounded too: FETCH_TIMEOUT, and the connection is not flagged", async () => {
    vi.useFakeTimers();
    abortSignalTimeoutOnFakeClock();
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(stallAfterHeaders(400)));

    const out = await settleWithin(refreshGoogleToken(makeConnection()), DEFAULT_FETCH_TIMEOUT_MS);

    expect(out).toMatchObject({ code: FETCH_TIMEOUT_CODE });
    expect(updateMock).not.toHaveBeenCalled();
  }, STALL_TEST_TIMEOUT_MS);
});
