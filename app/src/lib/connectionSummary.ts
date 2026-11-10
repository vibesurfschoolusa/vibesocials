import type { Platform } from "@prisma/client";

/**
 * SEC-1: Browser-safe projection of a SocialConnection row.
 *
 * `SocialConnection` rows carry secrets (accessToken, refreshToken, and page
 * access tokens inside `metadata`). Never pass a raw row into a `"use client"`
 * component — the App Router serializes every field into the RSC/HTML payload.
 * Map rows to this type server-side and pass only these display fields.
 *
 * Only add fields here that the client actually renders. Never add accessToken,
 * refreshToken, scopes, or the raw `metadata` JSON.
 */
export interface ConnectionSummary {
  /** Which platform this connection is for (used to match the UI row). */
  platform: Platform;
  /** Account handle/identifier; display fallback for the connected label. */
  accountIdentifier: string;
  /** Flattened `metadata.username`, if present. */
  username: string | null;
  /** Flattened `metadata.locationName` (Google Business Profile), if present. */
  locationName: string | null;
  /**
   * Roadmap Phase 4: true when a token refresh terminally failed or a
   * platform client mapped a 401 to its `*_RECONNECT_REQUIRED` code — see
   * server/platforms/connectionHealth.ts. NOT derived from `expiresAt`.
   */
  needsReconnect: boolean;
}

/** The SocialConnection columns Settings selects to build a ConnectionSummary. */
export interface ConnectionSummaryRow {
  platform: Platform;
  accountIdentifier: string;
  metadata: unknown;
  needsReconnect: boolean;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Maps a row to the browser-safe summary, reading only display fields from
 * `metadata`. The label is `metadata.username`, or for a Facebook Page its
 * `metadata.pageName` (server/connections/saveConnection.ts): without that,
 * Settings showed the Page's numeric id (2026-11-09).
 */
export function toConnectionSummary(row: ConnectionSummaryRow): ConnectionSummary {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  // A Business Profile is named by the location chosen in Settings
  // (metadata.locationTitle). Its accountIdentifier is a placeholder or an
  // opaque Google id, never shown (2026-11-09: "Connected as
  // google_business_profile").
  if (row.platform === "google_business_profile") {
    return {
      platform: row.platform,
      accountIdentifier: "",
      username: nonEmptyString(metadata.locationTitle),
      locationName: nonEmptyString(metadata.locationName),
      needsReconnect: row.needsReconnect,
    };
  }
  return {
    platform: row.platform,
    accountIdentifier: row.accountIdentifier,
    username: nonEmptyString(metadata.username) ?? nonEmptyString(metadata.pageName),
    locationName: nonEmptyString(metadata.locationName),
    needsReconnect: row.needsReconnect,
  };
}
