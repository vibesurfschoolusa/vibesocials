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
}

export interface ConnectionsResponse {
  connections: ConnectionStatus[];
}
