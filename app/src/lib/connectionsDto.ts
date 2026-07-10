import type { Platform } from "@prisma/client";

/**
 * Display-safe projection surfaced by `GET /api/connections`. Reports only
 * whether each platform is connected — never accessToken, refreshToken, scopes,
 * or metadata. Shared by the API route and the dashboard so the shape stays in
 * sync.
 */
export interface ConnectionStatus {
  platform: Platform;
  connected: boolean;
  /**
   * Roadmap Phase 4: true when a token refresh terminally failed (Google
   * invalid_grant) or a platform client mapped a 401 to its
   * `*_RECONNECT_REQUIRED` code — see server/platforms/connectionHealth.ts.
   * NOT derived from `expiresAt` (that's just the short-lived access-token
   * expiry). Always `false` when `connected` is `false`.
   */
  needsReconnect: boolean;
}

export interface ConnectionsResponse {
  connections: ConnectionStatus[];
}
