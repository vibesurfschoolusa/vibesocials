import type { Platform } from "@prisma/client";

import type { ConnectionExpiryState } from "@/lib/connectionExpiry";

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
  /**
   * R7-pages L4: a connection that can't be renewed and ends within the
   * warning window ("ends_soon"), or whose end passed before the daily sweep
   * flagged it ("ended"); null otherwise (lib/connectionExpiry.ts).
   */
  expiry?: ConnectionExpiryState;
}

export interface ConnectionsResponse {
  connections: ConnectionStatus[];
}
