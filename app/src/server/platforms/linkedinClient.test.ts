import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureFreshLinkedInToken,
  refreshLinkedInToken,
} from "@/server/platforms/linkedinClient";

// Mirrors googleTokens.test.ts: vi.mock + vi.hoisted are hoisted above imports,
// and refreshLinkedInToken resolves prisma via `await import("@/lib/db")` at
// call time, so it receives this mock. No real database is touched.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

function makeConnection(
  overrides: Partial<SocialConnection> = {},
): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    platform: "linkedin",
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
    // Default to already-expired so the ensure* tests exercise the expiry path.
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: "w_organization_social",
    metadata: { organizations: [{ id: "123", name: "Acme" }] },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
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
  vi.stubEnv("LINKEDIN_CLIENT_ID", "test-client-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "test-client-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refreshLinkedInToken", () => {
  it("updates ONLY accessToken and expiresAt, never refreshToken or metadata, and computes expiry", async () => {
    const expiresIn = 5_184_000; // 60 days
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "new-access-token",
        expires_in: expiresIn,
        // LinkedIn commonly ALSO returns a rotated refresh_token here; the
        // discipline is to ignore it and never write refreshToken.
        refresh_token: "rotated-refresh-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-42", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshLinkedInToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };

    expect(arg.where).toEqual({ id: "conn-42" });

    // The success write persists the new token + expiry and clears the
    // reconnect-health flags. It must NEVER touch refreshToken or metadata.
    expect(Object.keys(arg.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(arg.data).not.toHaveProperty("metadata");
    expect(arg.data.needsReconnect).toBe(false);
    expect(arg.data.accessToken).toBe("new-access-token");

    // Expiry math: now + expires_in seconds.
    const expiresMs = (arg.data.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + expiresIn * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + expiresIn * 1000);
  });

  it("falls back to a ~60-day default expiry when expires_in is missing, and still omits refreshToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "new-access-token",
        // expires_in intentionally omitted.
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-99", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshLinkedInToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };

    const expiresAt = arg.data.expiresAt as Date;
    const defaultTtlMs = 5_184_000 * 1000;
    expect(expiresAt instanceof Date && !isNaN(expiresAt.getTime())).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + defaultTtlMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + defaultTtlMs);
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("throws LINKEDIN_NO_REFRESH_TOKEN and never touches the network or database when no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ refreshToken: null });

    const error = await refreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_NO_REFRESH_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws LINKEDIN_MISSING_OAUTH_CREDENTIALS when client env vars are absent", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshLinkedInToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_MISSING_OAUTH_CREDENTIALS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws sanitized LINKEDIN_TOKEN_REFRESH_FAILED without leaking the upstream body or updating", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = "invalid_grant: refresh token expired SECRET123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshLinkedInToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");
    expect(error?.message).not.toContain(upstreamBody);
    expect(error?.message).toContain("400");
    expect(updateMock).not.toHaveBeenCalled();
    // Raw upstream body reaches the server logs, not the user-facing message.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);
  });
});

describe("ensureFreshLinkedInToken", () => {
  it("returns the connection unchanged without any network or DB call when the token is still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const future = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
    const connection = makeConnection({ expiresAt: future });

    const result = await ensureFreshLinkedInToken(connection);

    expect(result).toBe(connection);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws LINKEDIN_RECONNECT_REQUIRED (no network) and marks needsReconnect (flag fields only, no tokens) when expired and there is no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-55", refreshToken: null }); // expiresAt past by default

    const error = await ensureFreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(error?.message).toContain("reconnect");
    expect(fetchMock).not.toHaveBeenCalled();

    // Roadmap Phase 4: this is the common non-partner-app case — mark before
    // throwing. Flag fields only, never accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-55" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("refreshes and returns the updated connection when expired and a refresh token is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "fresh-token", expires_in: 5_184_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ refreshToken: "refresh-xyz" });

    const result = await ensureFreshLinkedInToken(connection);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(result.accessToken).toBe("fresh-token");
  });

  it("maps a refresh failure to LINKEDIN_RECONNECT_REQUIRED, preserving the original error as cause, and marks needsReconnect (flag fields only, no tokens)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("invalid_grant", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-66", refreshToken: "dead-refresh-token" });

    const error = await ensureFreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; cause?: { code?: string } });

    expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(error?.cause?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");

    // Roadmap Phase 4: the wrapping guard marks on the actionable
    // LINKEDIN_RECONNECT_REQUIRED outcome — flag fields only, never
    // accessToken/refreshToken (refreshLinkedInToken's own failed attempt
    // above never touched the database either).
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-66" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});
