import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureFreshInstagramToken, instagramClient } from "@/server/platforms/instagramClient";

// Instagram stores a long-lived Facebook PAGE token with no refresh path, so
// the core behavior to pin is the expiry guard: usable token -> returned
// as-is; expired/near-expired -> a clean, coded reconnect error.
//
// ensureFreshInstagramToken() itself still has no DB import — Roadmap Phase 4
// marking is wrapped at instagramClient's call sites (publishVideo,
// refreshToken), not inside the guard, so it stays synchronous and directly
// testable. But instagramClient.ts now imports connectionHealth.ts (which
// resolves prisma via `await import("@/lib/db")` at call time), so the mock
// below is required for the refreshToken() tests further down.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConnection(
  overrides: Partial<SocialConnection> = {},
): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    platform: "instagram",
    accessToken: "page-access-token",
    refreshToken: null,
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "ig-account-1",
    scopes: null,
    metadata: { username: "acme", pageId: "page-1" },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ensureFreshInstagramToken", () => {
  it("returns the connection unchanged when the token is comfortably fresh", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day ahead
    const connection = makeConnection({ expiresAt: future });

    expect(ensureFreshInstagramToken(connection)).toBe(connection);
  });

  it("returns the connection unchanged when no expiry is recorded (cannot judge)", () => {
    const connection = makeConnection({ expiresAt: null });

    expect(ensureFreshInstagramToken(connection)).toBe(connection);
  });

  it("throws INSTAGRAM_RECONNECT_REQUIRED with an actionable message when the token has expired", () => {
    const connection = makeConnection(); // expiresAt in the past

    const error = (() => {
      try {
        ensureFreshInstagramToken(connection);
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(error?.message).toContain("reconnect");
  });

  it("throws INSTAGRAM_RECONNECT_REQUIRED when the token is within the 5-minute safety buffer", () => {
    const almostExpired = new Date(Date.now() + 2 * 60 * 1000); // 2 min ahead
    const connection = makeConnection({ expiresAt: almostExpired });

    const error = (() => {
      try {
        ensureFreshInstagramToken(connection);
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
  });
});

describe("instagramClient.refreshToken", () => {
  it("returns the connection unchanged without touching the database when the token is fresh", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const connection = makeConnection({ expiresAt: future });

    const result = await instagramClient.refreshToken!(connection);

    expect(result).toBe(connection);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("marks needsReconnect (flag fields only, no tokens) and rethrows INSTAGRAM_RECONNECT_REQUIRED when expired", async () => {
    const connection = makeConnection({ id: "conn-99" }); // expiresAt in the past

    const error = await instagramClient
      .refreshToken!(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");

    // Roadmap Phase 4: marked before the error propagates — flag fields
    // only, never accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-99" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});
