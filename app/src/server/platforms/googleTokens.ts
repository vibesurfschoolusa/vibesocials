import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { markConnectionNeedsReconnect } from "./connectionHealth";

// Server-only: touches prisma and Google OAuth client secrets.
//
// Consolidated Google OAuth token refresh. Replaces three byte-for-byte
// identical copies (youtubeClient.ts, googleBusinessProfileClient.ts,
// googleReviews.ts) that differed only in log prefix and the platform name
// embedded in error strings.
//
// PROGRAM-LEVEL HARD CONSTRAINT (pinned by googleTokens.test.ts):
// the database update writes ONLY `accessToken` and `expiresAt`. It must NEVER
// write `refreshToken` — Google does not always return a new refresh token on
// refresh, and overwriting the stored one would permanently break the account.

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Refresh the Google OAuth access token for a connection and persist the new
 * access token + expiry. Returns the updated {@link SocialConnection}.
 *
 * Throws (with `error.code` tags):
 * - `GOOGLE_NO_REFRESH_TOKEN` if the connection has no stored refresh token.
 * - `GOOGLE_MISSING_OAUTH_CREDENTIALS` if OAuth client env vars are absent.
 * - `GOOGLE_TOKEN_REFRESH_FAILED` if the token endpoint returns a non-2xx (via
 *   {@link assertOk}; the upstream body is logged server-side but not surfaced).
 */
export async function refreshGoogleToken(
  connection: SocialConnection,
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    // Roadmap Phase 4: no refresh token to retry with is a terminal,
    // connection-specific signal — mark needsReconnect before throwing (see
    // connectionHealth.ts). Flag fields only; never touches accessToken/
    // refreshToken.
    logger.warn("[GoogleTokens] No refresh token available; marking connection for reconnect", {
      connectionId: connection.id,
      code: "GOOGLE_NO_REFRESH_TOKEN",
    });
    await markConnectionNeedsReconnect(connection.id, "GOOGLE_NO_REFRESH_TOKEN");
    const error = new Error(
      "No refresh token available for this Google connection",
    ) as Error & { code: string };
    error.code = "GOOGLE_NO_REFRESH_TOKEN";
    throw error;
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // Deployment misconfiguration, not a per-connection failure — never
    // includes the (absent) client id/secret themselves, just that they're
    // missing.
    logger.error("[GoogleTokens] Missing Google OAuth credentials", {
      connectionId: connection.id,
      code: "GOOGLE_MISSING_OAUTH_CREDENTIALS",
    });
    const error = new Error(
      "Missing Google OAuth credentials",
    ) as Error & { code: string };
    error.code = "GOOGLE_MISSING_OAUTH_CREDENTIALS";
    throw error;
  }

  logger.info("[GoogleTokens] Refreshing access token", {
    connectionId: connection.id,
  });

  const response = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  try {
    await assertOk(response, {
      code: "GOOGLE_TOKEN_REFRESH_FAILED",
      prefix: "Failed to refresh Google access token",
    });
  } catch (error) {
    // Roadmap Phase 4: a non-2xx here is the real invalid_grant signal — mark
    // needsReconnect before rethrowing the sanitized error (see
    // connectionHealth.ts). Flag fields only; never touches accessToken/
    // refreshToken.
    //
    // Health H1: `assertOk` above already `console.error`s the raw upstream
    // status/body server-side (by design — see assertOk.ts), but WITHOUT a
    // connection id attached. That's precisely why an invalid_grant on one
    // user's reviews connection was hard to find in a shared log stream:
    // nothing tied the failure to a specific connection. This is the
    // structured, connection-correlated counterpart — connection id + the
    // sanitized error code only, never the tokens — and (via the logger) also
    // reaches Sentry as a real, filterable error event once monitoring is
    // enabled.
    logger.error("[GoogleTokens] Token refresh failed; marking connection for reconnect", {
      connectionId: connection.id,
      platform: connection.platform,
      code: (error as Error & { code?: string }).code ?? "GOOGLE_TOKEN_REFRESH_FAILED",
      error,
    });
    await markConnectionNeedsReconnect(connection.id, "GOOGLE_TOKEN_REFRESH_FAILED");
    throw error;
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
    token_type: string;
  };

  // Guard: fall back to Google's standard 3600s access-token TTL if expires_in is missing/non-finite, rather than persisting an Invalid Date.
  const expiresInSeconds =
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? tokenData.expires_in
      : 3600;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  // Update accessToken + expiresAt and clear the reconnect-health flags — a
  // successful refresh means the connection works again, so a stale
  // needsReconnect from an earlier transient failure must not persist. Never
  // touch refreshToken. (See file header.)
  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: tokenData.access_token,
      expiresAt,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      refreshFailedAt: null,
    },
  });

  logger.info("[GoogleTokens] Access token refreshed successfully", {
    connectionId: connection.id,
  });

  return updated;
}
