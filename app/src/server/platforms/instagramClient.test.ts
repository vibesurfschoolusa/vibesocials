import type { SocialConnection } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ensureFreshInstagramToken } from "@/server/platforms/instagramClient";

// Instagram stores a long-lived Facebook PAGE token with no refresh path, so
// the only behavior to pin is the expiry guard: usable token -> returned as-is;
// expired/near-expired -> a clean, coded reconnect error. instagramClient.ts
// has no DB import at module load, so no prisma mock is needed here.
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
