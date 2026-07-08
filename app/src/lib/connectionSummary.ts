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
}
