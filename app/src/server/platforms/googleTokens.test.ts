import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshGoogleToken } from "@/server/platforms/googleTokens";

// vi.mock + vi.hoisted are hoisted above imports by vitest; refreshGoogleToken
// resolves prisma via `await import("@/lib/db")` at call time, so it receives
// this mock. No real database is touched.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    platform: "youtube",
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: null,
    metadata: null,
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

    // THE program-level constraint: update data contains ONLY these two keys.
    expect(Object.keys(arg.data).sort()).toEqual(["accessToken", "expiresAt"]);
    expect(arg.data).not.toHaveProperty("refreshToken");
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

  it("throws GOOGLE_NO_REFRESH_TOKEN and never touches the database when no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ refreshToken: null });

    const error = await refreshGoogleToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_NO_REFRESH_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
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

  it("throws sanitized GOOGLE_TOKEN_REFRESH_FAILED without leaking the upstream body or updating", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = "invalid_grant: token has been expired or revoked SECRET123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshGoogleToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    expect(error?.message).not.toContain(upstreamBody);
    expect(error?.message).toContain("400");
    expect(updateMock).not.toHaveBeenCalled();
    // Raw upstream body reaches the server logs.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);
  });
});
