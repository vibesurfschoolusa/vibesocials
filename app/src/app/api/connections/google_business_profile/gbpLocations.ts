import { NextResponse } from "next/server";

import { refreshConnectionToken } from "@/server/platforms/connectionRefresh";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";
import type { SocialConnection } from "@prisma/client";

/**
 * The Maps locations the workspace's connected Google account lists: the
 * picker's list (GET .../locations) and, since F3 (2026-11-14 review, R1
 * client journey H2), the only locations POST .../location accepts. Moved
 * here unchanged from the GET route.
 */

export interface ListedGbpLocation {
  /** "accounts/{accountId}/locations/{locationId}". */
  resourceName: string;
  title: string | null;
  storeCode: string | null;
  address: string | null;
  accountName: string | null;
}

export type GbpLocationList =
  | { ok: true; locations: ListedGbpLocation[] }
  | { ok: false; response: NextResponse };

function refused(body: { error: string }, init: { status: number }): GbpLocationList {
  return { ok: false, response: NextResponse.json(body, init) };
}

interface GbpAccount {
  name?: string | null; // "accounts/{accountId}"
  accountName?: string | null;
}

interface GbpLocation {
  name?: string | null; // "locations/{locationId}" or similar
  title?: string | null;
  storeCode?: string | null;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string | null;
    administrativeArea?: string | null;
    regionCode?: string | null;
    postalCode?: string | null;
  } | null;
}

// Migrated to the shared `refreshGoogleToken` helper
// (src/server/platforms/googleTokens.ts) per Phase 4 / HLT-2, following the
// "wrap-don't-swap" rule the original NOTE required. The helper THROWS on
// failure, but this route's 401-retry in GET depends on a `null`-returning
// contract for its opportunistic retry, so we wrap the helper in
// try/catch -> null to preserve that contract exactly.
//
// Behavioural note: the helper updates ONLY accessToken + expiresAt (never
// refreshToken) and, when `expires_in` is absent, falls back to Google's
// standard 3600s expiry rather than persisting `expiresAt = null` as the old
// inline copy did. The GET caller only reads `refreshed.accessToken` (never
// `expiresAt`) and does not distinguish an expiry-null from a failure-null, so
// wrapping does not change its observable behaviour.
//
// 2026-11-01 scale audit (jobs, token refresh): the refresh runs under the
// per-connection lock (connectionRefresh.ts); a lock timeout, a gone or flagged
// connection also lands in the catch -> null, like any other failure.
async function refreshAccessToken(
  connection: SocialConnection,
): Promise<SocialConnection | null> {
  try {
    return await refreshConnectionToken(connection, (current) => refreshGoogleToken(current));
  } catch (error) {
    console.error("[GBP] Failed to refresh access token", { error });
    return null;
  }
}

/** Lists the locations of every account the connection's Google login can see. */
export async function listGbpLocations(connection: SocialConnection): Promise<GbpLocationList> {
  let accessToken = connection.accessToken;
  if (!accessToken) {
    return refused(
      { error: "Missing access token for Google Business Profile" },
      { status: 400 },
    );
  }

  const makeAuthHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
  });

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  try {
    // 1. List all accounts the user has access to.
    let accountsRes = await fetch(`${accountManagementBase}/accounts`, {
      headers: makeAuthHeaders(accessToken),
    });

    // If the token is expired or invalid, try to refresh it once.
    if (accountsRes.status === 401) {
      const refreshed = await refreshAccessToken(connection);
      if (refreshed && refreshed.accessToken) {
        accessToken = refreshed.accessToken;
        accountsRes = await fetch(`${accountManagementBase}/accounts`, {
          headers: makeAuthHeaders(accessToken),
        });
      }
    }

    if (!accountsRes.ok) {
      console.error("[GBP] accounts.list failed while listing locations", {
        status: accountsRes.status,
        statusText: accountsRes.statusText,
      });
      return refused(
        { error: "Failed to list Google Business Profile accounts" },
        { status: 502 },
      );
    }

    const accountsJson = (await accountsRes.json()) as {
      accounts?: GbpAccount[];
    };

    const accounts = accountsJson.accounts ?? [];
    const allLocations: ListedGbpLocation[] = [];

    // 2. For each account, list its locations via Business Information API.
    for (const account of accounts) {
      const accountName = account.name ?? undefined; // "accounts/{accountId}"
      if (!accountName) continue;

      const accountLabel = account.accountName ?? accountName;

      const url = new URL(`${businessInfoBase}/${accountName}/locations`);
      url.searchParams.set("readMask", "name,title,storeCode,storefrontAddress");

      const locationsRes = await fetch(url.toString(), {
        headers: makeAuthHeaders(accessToken),
      });

      if (!locationsRes.ok) {
        console.error("[GBP] accounts.locations.list failed", {
          accountName,
          status: locationsRes.status,
          statusText: locationsRes.statusText,
        });
        continue;
      }

      const locationsJson = (await locationsRes.json()) as {
        locations?: GbpLocation[];
      };

      const locations = locationsJson.locations ?? [];

      for (const loc of locations) {
        if (!loc.name) continue;

        // loc.name is typically "locations/{locationId}" for the Business Information API.
        const rawLocationName = loc.name;

        const locationId = rawLocationName.startsWith("locations/")
          ? rawLocationName.slice("locations/".length)
          : rawLocationName;

        const [, accountId] = accountName.split("/");
        const fullResourceName = accountId
          ? `accounts/${accountId}/locations/${locationId}`
          : `${accountName}/${locationId}`;

        const addr = loc.storefrontAddress ?? undefined;
        const addressParts: string[] = [];

        if (addr?.addressLines && addr.addressLines.length > 0) {
          addressParts.push(addr.addressLines.join(" "));
        }
        if (addr?.locality) addressParts.push(addr.locality);
        if (addr?.administrativeArea) addressParts.push(addr.administrativeArea);
        if (addr?.regionCode) addressParts.push(addr.regionCode);
        if (addr?.postalCode) addressParts.push(addr.postalCode);

        allLocations.push({
          resourceName: fullResourceName,
          title: loc.title ?? null,
          storeCode: loc.storeCode ?? null,
          address: addressParts.join(", ") || null,
          accountName: accountLabel,
        });
      }
    }

    return { ok: true, locations: allLocations };
  } catch (error) {
    console.error("[GBP] Unexpected error while listing locations", { error });
    return refused(
      { error: "Unexpected error while listing Google Business Profile locations" },
      { status: 500 },
    );
  }
}
