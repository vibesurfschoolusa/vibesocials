import { NextResponse } from "next/server";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  classifyGoogleFailure,
  flagIfTokenRejected,
  googleFailureKind,
  type GoogleFailureKind,
} from "@/server/googleFailure";
import type { TokenSnapshot } from "@/server/platforms/connectionHealth";
import { readGoogleErrorReasons } from "@/server/platforms/rateLimited";
import {
  CONNECTION_RECONNECT_REQUIRED_CODE,
  refreshConnectionToken,
} from "@/server/platforms/connectionRefresh";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";
import type { SocialConnection } from "@prisma/client";

/**
 * The Maps locations the workspace's connected Google account lists: the
 * picker's list (GET .../locations), the only locations POST .../location
 * accepts (F3), and since R25 (client-journey M1) the Reviews page's list and
 * the reply route's location check too. One paged reader (readGbpLocations)
 * serves all of them, so a login with more than one page of accounts or
 * locations is listed, and checked, in full everywhere.
 */

/** Locations asked for per page (the Business Information API allows 100). */
const LOCATIONS_PAGE_SIZE = 100;

/** Pages read of any one list before giving up: 5,000 locations for one account. */
export const GBP_MAX_PAGES = 50;

const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

/** R25 security-billing L1: every Google route's window; Google counts quota per Cloud project. */
const GOOGLE_ROUTE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The per-person limit on a route that calls Google (R25 security-billing L1),
 * checked before any Google call: a 429 answer when over it, else null.
 */
export async function googleRouteRateLimit(userId: string, route: string, limit = 60): Promise<NextResponse | null> {
  const rateLimit = await checkRateLimit({ userId, route, limit, windowMs: GOOGLE_ROUTE_WINDOW_MS });
  if (rateLimit.allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
  );
}

/**
 * What the picker (owner-only) says for each kind of Google failure
 * (server/googleFailure.ts decides the kind; JJ3 lead review).
 * tryLater: Google or our own setup failed; trying again later may work.
 */
export const GOOGLE_NO_ANSWER_MESSAGE = "Google didn't answer. Try again in a minute.";
/**
 * access: this Google login may not read its Business Profile accounts. The
 * step is the in-place sign-in (`signIn: true`; lib/gbpSignIn.ts), which keeps
 * the row, its numbers and the location when the new account can read it
 * (R25 client-journey L1), never Switch account, which deletes them.
 */
export const GBP_ACCOUNTS_REFUSED_MESSAGE =
  "Google refused access to the Business Profile accounts of this Google account. Sign in to Google again with the account that manages your listing.";
/**
 * Every account was read and none has a location (sent as `notice`, with
 * `signIn: true`). Both causes are said: another account manages the listing,
 * or the business has none yet (signing in again cannot fix that). The picker
 * is owner-only, so there is no member wording.
 */
export const GBP_NO_LISTING_NOTICE =
  "Google found no locations for this Google account. If your business has a listing, sign in to Google again with the account that manages it. If it doesn't have one yet, create or verify it in Google Business Profile first.";
/** other: the accounts list did not come back, for no reason we can name. */
export const GBP_ACCOUNTS_NOT_SENT_MESSAGE =
  "Google didn't send your Business Profile accounts. Press Fetch locations from Google again in a minute.";
/** Shown with the list when some accounts' locations could not be read: access refused. */
export const GBP_SOME_ACCOUNTS_REFUSED_NOTICE =
  "Google refused access to some of your Business Profile accounts, so their locations aren't listed. Check in Google Business Profile that this Google account still manages them.";
/** The same, when Google failed for them instead (the picker's step). */
export const GBP_SOME_ACCOUNTS_FAILED_NOTICE =
  "Google didn't send the locations of some of your Business Profile accounts. Press Fetch locations from Google again in a minute to see them all.";
/** The same on the Reviews page, which has no Fetch button. */
export const GBP_SOME_ACCOUNTS_FAILED_REVIEWS_NOTICE =
  "Google didn't send the locations of some of your Business Profile accounts. Reload this page in a minute to see them all.";

/**
 * R24 platform-clients L1: the grant is dead (the row is flagged, or Google
 * refused the token), so only a reconnect helps. `code` lets the form tell
 * it apart and show the card's Reconnect state; `signIn: true` keeps the
 * in-place sign-in, the Reconnect button's own URL.
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
 * failed, or ran past GBP_MAX_PAGES): the list still shows what was read, but
 * the location save must not treat a missing location as "not listed".
 * `unread` says why accounts were skipped: some refused access, some failed
 * (Google, or a kind with no fix here), or both (JJ3 lead review: both are said).
 * `refusedOnly` is true when access refusals are the only reason the list is
 * not complete: a location missing from it is then not one this login manages.
 *
 * Not ok: the whole list failed, with its kind (already logged): the accounts
 * call failed, the token itself was refused (the row is flagged), or no
 * account's locations could be read at all (R25 new-customer L4).
 */
export type GbpListing =
  | {
      ok: true;
      locations: ListedGbpLocation[];
      complete: boolean;
      unread: UnreadAccounts;
      refusedOnly: boolean;
    }
  | { ok: false; kind: GoogleFailureKind };

/** The picker's listing: a failure is already its answer. */
export type GbpLocationList = Extract<GbpListing, { ok: true }> | { ok: false; response: NextResponse };

export interface UnreadAccounts {
  access: boolean;
  failed: boolean;
}

/**
 * The line about skipped accounts, each reason with its own step; null when
 * none were skipped. The failed step names the surface's own control.
 */
export function unreadAccountsNotice(unread: UnreadAccounts, surface: "picker" | "reviews" = "picker"): string | null {
  const parts = [
    unread.access ? GBP_SOME_ACCOUNTS_REFUSED_NOTICE : null,
    unread.failed
      ? surface === "reviews"
        ? GBP_SOME_ACCOUNTS_FAILED_REVIEWS_NOTICE
        : GBP_SOME_ACCOUNTS_FAILED_NOTICE
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function refused(body: { error: string; code?: string; signIn?: true }, init: { status: number }): GbpLocationList {
  return { ok: false, response: NextResponse.json(body, init) };
}

const reconnectRefusal = (): GbpLocationList =>
  refused({ error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE, signIn: true }, { status: 409 });

/** The whole list failed: the picker's answer for each kind. */
function pickerRefusal(kind: GoogleFailureKind): GbpLocationList {
  switch (kind) {
    case "reconnect":
      return reconnectRefusal();
    case "access":
      return refused({ error: GBP_ACCOUNTS_REFUSED_MESSAGE, signIn: true }, { status: 403 });
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
// failure, but this route's 401-retry depends on a `null`-returning contract
// for its opportunistic retry, so we wrap the helper in try/catch -> null.
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

/** One Google GET with the bearer token, under the shared request timeout. */
function googleGet(url: URL, accessToken: string): Promise<Response> {
  return fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** A location's entry in the list, from its account and Google's location. */
function listedLocation(accountName: string, accountLabel: string, loc: GbpLocation & { name: string }): ListedGbpLocation {
  // loc.name is typically "locations/{locationId}" for the Business Information API.
  const locationId = loc.name.startsWith("locations/") ? loc.name.slice("locations/".length) : loc.name;
  const [, accountId] = accountName.split("/");
  const resourceName = accountId ? `accounts/${accountId}/locations/${locationId}` : `${accountName}/${locationId}`;

  const addr = loc.storefrontAddress ?? undefined;
  const addressParts: string[] = [];
  if (addr?.addressLines && addr.addressLines.length > 0) addressParts.push(addr.addressLines.join(" "));
  if (addr?.locality) addressParts.push(addr.locality);
  if (addr?.administrativeArea) addressParts.push(addr.administrativeArea);
  if (addr?.regionCode) addressParts.push(addr.regionCode);
  if (addr?.postalCode) addressParts.push(addr.postalCode);

  return {
    resourceName,
    title: loc.title ?? null,
    storeCode: loc.storeCode ?? null,
    address: addressParts.join(", ") || null,
    accountName: accountLabel,
  };
}

interface ReadOptions {
  /** Where the list is read, for the one log line per failure (classifyGoogleFailure). */
  where: string;
  get: (url: URL) => Promise<Response>;
  /** The tokens the latest request sent: a token Google refused is flagged with them. */
  used: () => TokenSnapshot;
  /** The failure to sort: the picker sorts a 401 after a failed refresh by what the refresh said. */
  effective?: (failure: unknown) => unknown;
}

/**
 * The one paged listing: every account the login sees, and every location of
 * each, via the Business Information API. Each failure is logged once, by
 * kind. A token Google refused (googleFailure.ts) is flagged through
 * flagIfTokenRejected, so the card shows Reconnect (R25 platform-clients L2).
 */
export async function readGbpLocations(options: ReadOptions): Promise<GbpListing> {
  const { where, get, used } = options;
  const effective = options.effective ?? ((failure: unknown) => failure);
  const wholeListFailed = async (failure: unknown): Promise<GbpListing> => {
    const settled = await flagIfTokenRejected(effective(failure), used());
    return { ok: false, kind: classifyGoogleFailure(settled, where) };
  };

  // 1. Every account the login has access to.
  const accounts = await readAllPages<GbpAccount>(new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`), "accounts", get);
  if (!accounts.ok) return wholeListFailed(accounts.failure);

  let complete = accounts.complete;
  const unread: UnreadAccounts = { access: false, failed: false };
  // Not complete for a reason other than an account refusing access.
  let partlyUnread = !accounts.complete;
  let accountsRead = 0;
  let accountsNamed = 0;
  const allLocations: ListedGbpLocation[] = [];

  // 2. Every location of each account.
  for (const account of accounts.items) {
    const accountName = account.name ?? undefined; // "accounts/{accountId}"
    if (!accountName) continue;
    accountsNamed += 1;

    const url = new URL(`${BUSINESS_INFO_BASE}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,title,storeCode,storefrontAddress");
    url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));

    const locations = await readAllPages<GbpLocation>(url, "locations", get);
    if (!locations.ok) {
      // The token itself was refused: the whole list ends with that step.
      if (googleFailureKind(effective(locations.failure)) === "reconnect") return wholeListFailed(locations.failure);
      // Skipped, and said so (unreadAccountsNotice), with why.
      if (classifyGoogleFailure(effective(locations.failure), where) === "access") {
        unread.access = true;
      } else {
        unread.failed = true;
        partlyUnread = true;
      }
      complete = false;
      continue;
    }
    accountsRead += 1;
    if (!locations.complete) {
      complete = false;
      partlyUnread = true;
    }

    const accountLabel = account.accountName ?? accountName;
    for (const loc of locations.items) {
      if (loc.name) allLocations.push(listedLocation(accountName, accountLabel, { ...loc, name: loc.name }));
    }
  }

  // R25 new-customer L4: nothing could be read, so this is the whole list's
  // failure (each skipped account was logged above), not "some of your accounts".
  if (accountsNamed > 0 && accountsRead === 0) {
    return { ok: false, kind: unread.failed ? "tryLater" : "access" };
  }

  return { ok: true, locations: allLocations, complete, unread, refusedOnly: !complete && !partlyUnread };
}

/**
 * The listing for a token the caller already holds (the Reviews routes, which
 * refresh it early first): `used` is the row it came from.
 */
export function listGbpLocationsWithToken(used: TokenSnapshot, where: string): Promise<GbpListing> {
  return readGbpLocations({ where, get: (url) => googleGet(url, used.accessToken), used: () => used });
}

/**
 * The picker's listing (owner-only routes): one token refresh at most, on the
 * first 401 (an expired access token), and a failure already worded.
 */
export async function listGbpLocations(connection: SocialConnection): Promise<GbpLocationList> {
  if (!connection.accessToken) {
    return refused(
      { error: "Missing access token for Google Business Profile" },
      { status: 400 },
    );
  }

  // A row already flagged asks for a reconnect without asking Google, as the
  // Reviews routes do.
  if (connection.needsReconnect) return reconnectRefusal();

  let current: TokenSnapshot = {
    id: connection.id,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken ?? null,
  };
  let refreshed = false;
  let refreshFailure: unknown = null;
  const get = async (url: URL): Promise<Response> => {
    const response = await googleGet(url, current.accessToken);
    if (response.status !== 401 || refreshed) return response;
    refreshed = true;
    const { renewed, failure } = await refreshAccessToken(connection);
    refreshFailure = failure;
    if (!renewed?.accessToken) return response;
    current = { id: renewed.id, accessToken: renewed.accessToken, refreshToken: renewed.refreshToken ?? null };
    return googleGet(url, current.accessToken);
  };

  try {
    const listing = await readGbpLocations({
      where: "GBP location picker",
      get,
      used: () => current,
      // A 401 after a failed refresh is sorted by what the refresh said.
      effective: (failure) => refreshFailure ?? failure,
    });
    return listing.ok ? listing : pickerRefusal(listing.kind);
  } catch (error) {
    console.error("[GBP] Unexpected error while listing locations", { error });
    return refused(
      { error: "Unexpected error while listing Google Business Profile locations" },
      { status: 500 },
    );
  }
}
