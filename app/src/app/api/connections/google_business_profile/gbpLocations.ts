import { NextResponse } from "next/server";

import { refreshConnectionToken } from "@/server/platforms/connectionRefresh";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";
import type { SocialConnection } from "@prisma/client";

/**
 * The Maps locations the workspace's connected Google account lists: the
 * picker's list (GET .../locations) and, since F3 (2026-11-14 review, R1
 * client journey H2), the only locations POST .../location accepts. Moved
 * here from the GET route; since the F3 review it pages through both lists,
 * so a login with more than one page of accounts or locations is checked
 * against all of them.
 */

/** Locations asked for per page (the Business Information API allows 100). */
const LOCATIONS_PAGE_SIZE = 100;

/** Pages read of any one list before giving up: 5,000 locations for one account. */
export const GBP_MAX_PAGES = 50;

/** Google failed (429, 5xx or no answer at all); trying again later may work. */
export const GOOGLE_NO_ANSWER_MESSAGE = "Google didn't answer. Try again in a minute.";

export interface ListedGbpLocation {
  /** "accounts/{accountId}/locations/{locationId}". */
  resourceName: string;
  title: string | null;
  storeCode: string | null;
  address: string | null;
  accountName: string | null;
}

/**
 * `complete` is false when an account's locations could not all be read (it
 * failed, or ran past GBP_MAX_PAGES): the picker still shows what was read,
 * but the location save must not treat a missing location as "not listed".
 */
export type GbpLocationList =
  | { ok: true; locations: ListedGbpLocation[]; complete: boolean }
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

type PageResult<T> =
  | { ok: true; items: T[]; complete: boolean }
  | { ok: false; status: number | null };

/**
 * Every page of one Google list (`key` names its array), following
 * nextPageToken until there is none. A token seen before ends the list (its
 * pages were already read), and GBP_MAX_PAGES ends it as not complete. A
 * failed page fails the list; `status` is null when nothing answered.
 */
async function readAllPages<T>(
  first: URL,
  key: string,
  get: (url: URL) => Promise<Response>,
): Promise<PageResult<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < GBP_MAX_PAGES; page += 1) {
    const url = new URL(first);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let json: Record<string, unknown> | null;
    try {
      const response = await get(url);
      if (!response.ok) return { ok: false, status: response.status };
      json = (await response.json()) as Record<string, unknown> | null;
    } catch {
      return { ok: false, status: null };
    }
    const pageItems = json?.[key];
    if (Array.isArray(pageItems)) items.push(...(pageItems as T[]));
    const next = json?.nextPageToken;
    if (typeof next !== "string" || !next || seen.has(next)) {
      return { ok: true, items, complete: true };
    }
    seen.add(next);
    pageToken = next;
  }
  return { ok: true, items, complete: false };
}

/** A 429, a 5xx or no answer: Google, not the request, failed. */
function googleDidNotAnswer(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
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

  // One token refresh at most, on the first 401 (an expired access token).
  let refreshed = false;
  const get = async (url: URL): Promise<Response> => {
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status !== 401 || refreshed) return response;
    refreshed = true;
    const renewed = await refreshAccessToken(connection);
    if (!renewed?.accessToken) return response;
    accessToken = renewed.accessToken;
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  };

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  try {
    // 1. Every account the login has access to.
    const accounts = await readAllPages<GbpAccount>(new URL(`${accountManagementBase}/accounts`), "accounts", get);
    if (!accounts.ok) {
      console.error("[GBP] accounts.list failed while listing locations", { status: accounts.status });
      return googleDidNotAnswer(accounts.status)
        ? refused({ error: GOOGLE_NO_ANSWER_MESSAGE }, { status: 503 })
        : refused({ error: "Failed to list Google Business Profile accounts" }, { status: 502 });
    }

    let complete = accounts.complete;
    const allLocations: ListedGbpLocation[] = [];

    // 2. Every location of each account, via the Business Information API.
    for (const account of accounts.items) {
      const accountName = account.name ?? undefined; // "accounts/{accountId}"
      if (!accountName) continue;

      const accountLabel = account.accountName ?? accountName;

      const url = new URL(`${businessInfoBase}/${accountName}/locations`);
      url.searchParams.set("readMask", "name,title,storeCode,storefrontAddress");
      url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));

      const locations = await readAllPages<GbpLocation>(url, "locations", get);
      if (!locations.ok) {
        console.error("[GBP] accounts.locations.list failed", { accountName, status: locations.status });
        complete = false;
        continue;
      }
      if (!locations.complete) complete = false;

      for (const loc of locations.items) {
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

    return { ok: true, locations: allLocations, complete };
  } catch (error) {
    console.error("[GBP] Unexpected error while listing locations", { error });
    return refused(
      { error: "Unexpected error while listing Google Business Profile locations" },
      { status: 500 },
    );
  }
}
