import { NextResponse } from "next/server";

import { classifyGoogleFailure, type GoogleFailureKind } from "@/server/googleFailure";
import { readGoogleErrorReasons } from "@/server/platforms/rateLimited";
import {
  CONNECTION_RECONNECT_REQUIRED_CODE,
  refreshConnectionToken,
} from "@/server/platforms/connectionRefresh";
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

/**
 * What the picker (owner-only) says for each kind of Google failure
 * (server/googleFailure.ts decides the kind; JJ3 lead review).
 * tryLater: Google or our own setup failed; trying again later may work.
 */
export const GOOGLE_NO_ANSWER_MESSAGE = "Google didn't answer. Try again in a minute.";
/** access: this Google login may not read its Business Profile accounts. */
export const GBP_ACCOUNTS_REFUSED_MESSAGE =
  "Google refused access to the Business Profile accounts of this Google account. Press Switch account above and sign in with the Google account that manages your listing.";
/** other: the accounts list did not come back, for no reason we can name. */
export const GBP_ACCOUNTS_NOT_SENT_MESSAGE =
  "Google didn't send your Business Profile accounts. Press Fetch locations from Google again in a minute.";
/** Shown with the list when some accounts' locations could not be read: access refused. */
export const GBP_SOME_ACCOUNTS_REFUSED_NOTICE =
  "Google refused access to some of your Business Profile accounts, so their locations aren't listed. Check in Google Business Profile that this Google account still manages them.";
/** The same, when Google failed for them instead. */
export const GBP_SOME_ACCOUNTS_FAILED_NOTICE =
  "Google didn't send the locations of some of your Business Profile accounts. Press Fetch locations from Google again in a minute to see them all.";

/**
 * R24 platform-clients L1: the grant is dead (the row is flagged, or Google
 * refused the refresh), so only a reconnect helps. `code` lets the form tell
 * it apart and show the card's Reconnect state.
 */
export const GBP_RECONNECT_MESSAGE = "Reconnect Google Business Profile in Settings, then try again.";
export const GBP_RECONNECT_CODE = CONNECTION_RECONNECT_REQUIRED_CODE;

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
 * `unread` says why accounts were skipped: "access" when any refused access
 * (the person can fix that), "failed" when Google failed for them, else null.
 * `refusedOnly` is true when access refusals are the only reason the list is
 * not complete: a location missing from it is then not one this login manages.
 */
export type GbpLocationList =
  | {
      ok: true;
      locations: ListedGbpLocation[];
      complete: boolean;
      unread: "access" | "failed" | null;
      refusedOnly: boolean;
    }
  | { ok: false; response: NextResponse };

/** The picker's line about skipped accounts, or null when none were skipped. */
export function unreadAccountsNotice(unread: "access" | "failed" | null): string | null {
  if (unread === "access") return GBP_SOME_ACCOUNTS_REFUSED_NOTICE;
  return unread === "failed" ? GBP_SOME_ACCOUNTS_FAILED_NOTICE : null;
}

function refused(body: { error: string; code?: string }, init: { status: number }): GbpLocationList {
  return { ok: false, response: NextResponse.json(body, init) };
}

const reconnectRefusal = (): GbpLocationList =>
  refused({ error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE }, { status: 409 });

/** The accounts list failed: the answer for each kind. */
function accountsRefusal(kind: GoogleFailureKind): GbpLocationList {
  switch (kind) {
    case "reconnect":
      return reconnectRefusal();
    case "access":
      return refused({ error: GBP_ACCOUNTS_REFUSED_MESSAGE }, { status: 403 });
    case "tryLater":
      return refused({ error: GOOGLE_NO_ANSWER_MESSAGE }, { status: 503 });
    default:
      return refused({ error: GBP_ACCOUNTS_NOT_SENT_MESSAGE }, { status: 502 });
  }
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
//
// R24 platform-clients L1 / JJ3 lead review: a failed refresh is kept, so the
// failure it caused is sorted by what the refresh said (googleFailure.ts).
async function refreshAccessToken(
  connection: SocialConnection,
): Promise<{ renewed: SocialConnection | null; failure: unknown }> {
  try {
    return { renewed: await refreshConnectionToken(connection, (current) => refreshGoogleToken(current)), failure: null };
  } catch (error) {
    return { renewed: null, failure: error };
  }
}

/** `failure` carries status and Google's reasons (or is what was thrown, when nothing answered). */
type PageResult<T> =
  | { ok: true; items: T[]; complete: boolean }
  | { ok: false; failure: unknown };

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
      if (!response.ok) {
        const googleReasons = await readGoogleErrorReasons(response);
        return {
          ok: false,
          failure: Object.assign(new Error("Google list failed"), { status: response.status, googleReasons }),
        };
      }
      json = (await response.json()) as Record<string, unknown> | null;
    } catch (error) {
      return { ok: false, failure: error };
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

/** Lists the locations of every account the connection's Google login can see. */
export async function listGbpLocations(connection: SocialConnection): Promise<GbpLocationList> {
  let accessToken = connection.accessToken;
  if (!accessToken) {
    return refused(
      { error: "Missing access token for Google Business Profile" },
      { status: 400 },
    );
  }

  // A row already flagged asks for a reconnect without asking Google, as the
  // Reviews routes do.
  if (connection.needsReconnect) return reconnectRefusal();

  // One token refresh at most, on the first 401 (an expired access token).
  let refreshed = false;
  let refreshFailure: unknown = null;
  const get = async (url: URL): Promise<Response> => {
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status !== 401 || refreshed) return response;
    refreshed = true;
    const { renewed, failure } = await refreshAccessToken(connection);
    refreshFailure = failure;
    if (!renewed?.accessToken) return response;
    accessToken = renewed.accessToken;
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  };

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  try {
    // 1. Every account the login has access to.
    const accounts = await readAllPages<GbpAccount>(new URL(`${accountManagementBase}/accounts`), "accounts", get);
    // A 401 after a failed refresh is sorted by what the refresh said.
    // Each failure is logged once, by kind (classifyGoogleFailure).
    const kindOf = (failure: unknown) => classifyGoogleFailure(refreshFailure ?? failure, "GBP location picker");
    if (!accounts.ok) return accountsRefusal(kindOf(accounts.failure));

    let complete = accounts.complete;
    let unread: "access" | "failed" | null = null;
    // Not complete for a reason other than an account refusing access.
    let partlyUnread = !accounts.complete;
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
        const kind = kindOf(locations.failure);
        if (kind === "reconnect") return reconnectRefusal();
        // Skipped, and said so (unreadAccountsNotice): access refused is what
        // the person can fix, so it outranks Google failing.
        unread = kind === "access" || unread === "access" ? "access" : "failed";
        if (kind !== "access") partlyUnread = true;
        complete = false;
        continue;
      }
      if (!locations.complete) {
        complete = false;
        partlyUnread = true;
      }

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

    return { ok: true, locations: allLocations, complete, unread, refusedOnly: !complete && !partlyUnread };
  } catch (error) {
    console.error("[GBP] Unexpected error while listing locations", { error });
    return refused(
      { error: "Unexpected error while listing Google Business Profile locations" },
      { status: 500 },
    );
  }
}
