import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  classifyGoogleFailure,
  flagIfTokenRejected,
  googleFailureKind,
  type GoogleFailureKind,
} from "@/server/googleFailure";

import type { TokenSnapshot } from "./connectionHealth";
import { budgetedTimeout } from "./publishBudget";
import { classifyRateLimit, readGoogleErrorReasons } from "./rateLimited";

// Server-only: the Google Business Profile location listing, and the
// store-code resolver that reads it.
//
// R25 (client-journey M1 and the lead's follow-up): one paged listing,
// readGbpLocations, serves the Reviews page, the Settings picker
// (api/connections/google_business_profile/gbpLocations.ts) and the
// store-code lookup below. So a login with more than one page of accounts or
// locations is read in full everywhere: 100 locations a page, every
// nextPageToken followed (accounts too, at the page size Google sets), and
// each request through fetchWithTimeout.

/** Locations asked for per page (the Business Information API allows 100). */
const LOCATIONS_PAGE_SIZE = 100;

/** Pages read of any one list before giving up: 5,000 locations for one account. */
export const GBP_MAX_PAGES = 50;

const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

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
 * account's locations could be read at all (R25 new-customer L4). `failure`
 * is the error behind it, with Google's status when Google answered.
 */
export type GbpListing =
  | {
      ok: true;
      locations: ListedGbpLocation[];
      complete: boolean;
      unread: UnreadAccounts;
      refusedOnly: boolean;
      /** The failure of an account skipped for a reason other than access (Google's status), else null. */
      skippedFailure: unknown;
    }
  | { ok: false; kind: GoogleFailureKind; failure: unknown };

export interface UnreadAccounts {
  access: boolean;
  failed: boolean;
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
  rethrow: (error: unknown) => boolean,
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
      if (rethrow(error)) throw error;
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
  /**
   * The tokens the latest request sent: a token Google refused is flagged with
   * them. Null when the caller flags it itself (the Reviews routes).
   */
  used: () => TokenSnapshot | null;
  /** Errors `get` throws that end the reading as they are (a rate limit, the step's time budget). */
  rethrow?: (error: unknown) => boolean;
  /**
   * Google's own `filter` on each account's locations (e.g. `storeCode="X"`):
   * a lookup of one location then costs a call or two per account, not every page.
   */
  locationsFilter?: string;
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
  const rethrow = options.rethrow ?? (() => false);
  const wholeListFailed = async (failure: unknown): Promise<GbpListing> => {
    const settled = await flagIfTokenRejected(effective(failure), used());
    return { ok: false, kind: classifyGoogleFailure(settled, where), failure: settled };
  };

  // 1. Every account the login has access to.
  const accounts = await readAllPages<GbpAccount>(new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`), "accounts", get, rethrow);
  if (!accounts.ok) return wholeListFailed(accounts.failure);

  let complete = accounts.complete;
  const unread: UnreadAccounts = { access: false, failed: false };
  // Not complete for a reason other than an account refusing access.
  let partlyUnread = !accounts.complete;
  let accountsRead = 0;
  let accountsNamed = 0;
  let lastSkipped: unknown = null;
  let skippedFailure: unknown = null;
  const allLocations: ListedGbpLocation[] = [];

  // 2. Every location of each account.
  for (const account of accounts.items) {
    const accountName = account.name ?? undefined; // "accounts/{accountId}"
    if (!accountName) continue;
    accountsNamed += 1;

    const url = new URL(`${BUSINESS_INFO_BASE}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,title,storeCode,storefrontAddress");
    url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));
    if (options.locationsFilter) url.searchParams.set("filter", options.locationsFilter);

    const locations = await readAllPages<GbpLocation>(url, "locations", get, rethrow);
    if (!locations.ok) {
      // The token itself was refused: the whole list ends with that step.
      if (googleFailureKind(effective(locations.failure)) === "reconnect") return wholeListFailed(locations.failure);
      // Skipped, and said so (unreadAccountsNotice), with why.
      lastSkipped = effective(locations.failure);
      if (classifyGoogleFailure(effective(locations.failure), where) === "access") {
        unread.access = true;
      } else {
        unread.failed = true;
        partlyUnread = true;
        skippedFailure = lastSkipped;
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
    return { ok: false, kind: unread.failed ? "tryLater" : "access", failure: lastSkipped };
  }

  return {
    ok: true,
    locations: allLocations,
    complete,
    unread,
    refusedOnly: !complete && !partlyUnread,
    skippedFailure,
  };
}

/** The store-code lookup's failure when the accounts call failed, or no account's locations could be read. */
function accountsListFailed(failure: unknown): Error {
  const status = (failure as { status?: unknown } | null)?.status;
  const known = typeof status === "number";
  return Object.assign(
    new Error(`Failed to list Google Business Profile accounts while resolving location${known ? ` (status ${status})` : ""}`),
    { code: "GBP_ACCOUNTS_LIST_FAILED", ...(known ? { status } : {}) },
  );
}

/**
 * Resolve a Google Business Profile location to its full resource name
 * (`accounts/{accountId}/locations/{locationId}`).
 *
 * Accepts either:
 * - A full resource name already starting with `accounts/`, returned as-is.
 * - A Store code (from Advanced settings), resolved through the shared paged
 *   listing: the location whose `storeCode` matches, on any page of any account.
 *
 * Throws (with `error.code` tags):
 * - Google's own failure (a 401, a missing scope) when it refused the token, or
 *   CONNECTION_TOKEN_CHANGED.
 *   With `used` (the row the token came from) the row is flagged first, as on
 *   every Google call (R25); callers without it flag in their own catch.
 * - `GBP_ACCOUNTS_LIST_FAILED`, with Google's status, if the accounts list
 *   fails or no account's locations could be read.
 * - `RATE_LIMITED` on a 429 (2026-11-01 scale audit: a throttled account is
 *   never skipped, which would end as a misleading not found).
 * - `GBP_STORE_CODE_NOT_FOUND` if no location matches the store code.
 * - `GBP_STORE_CODE_NOT_UNIQUE` if more than one location matches.
 * - `PUBLISH_TIME_BUDGET_EXCEEDED` if `deadline` leaves under 5 s for the next
 *   request (nothing is sent).
 *
 * `deadline` (epoch ms, publishBudget.ts): every request timeout is clamped to
 * the time left and none is started with under 5 s left. A full resource name
 * needs no request, so it is returned whatever is left. Without a deadline each
 * request keeps its 30 s default.
 */
export async function resolveGbpLocationName(
  accessToken: string,
  locationNameOrStoreCode: string,
  deadline?: number,
  used?: TokenSnapshot,
): Promise<string> {
  const trimmed = locationNameOrStoreCode.trim();

  // Already a full resource name: use it as-is.
  if (trimmed.startsWith("accounts/")) {
    return trimmed;
  }

  const get = async (url: URL): Promise<Response> => {
    const response = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
    );
    const limited = await classifyRateLimit("google_business_profile", response);
    if (limited) throw limited;
    return response;
  };

  const listing = await readGbpLocations({
    where: "GBP store code lookup",
    get,
    used: () => used ?? null,
    // Anything thrown ends the lookup as it is, as before: a rate limit, the
    // step's time budget, a timeout or no answer. Skipping that account would
    // end as a misleading not found.
    rethrow: () => true,
    // R25 lead review: Google's own filter, so the lookup costs a call or two per account.
    locationsFilter: `storeCode="${trimmed}"`,
  });
  if (!listing.ok) {
    // The token itself was refused (a 401, a missing scope), or the tokens changed meanwhile.
    const code = (listing.failure as { code?: unknown } | null)?.code;
    if (listing.kind === "reconnect" || code === "CONNECTION_TOKEN_CHANGED") throw listing.failure;
    throw accountsListFailed(listing.failure);
  }

  const candidates = listing.locations.filter((location) => location.storeCode === trimmed);

  // R25 lead review: an account that failed (not one that refused access, which
  // can't be posted to anyway) may hold the code, so no match there is Google's
  // failure, retried and worded "try later", never "choose the location again".
  if (candidates.length === 0 && !listing.complete && !listing.refusedOnly) {
    throw accountsListFailed(listing.skippedFailure);
  }

  if (candidates.length === 0) {
    const error = new Error(
      "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
    ) as Error & { code: string };
    error.code = "GBP_STORE_CODE_NOT_FOUND";
    throw error;
  }

  if (candidates.length > 1) {
    const error = new Error(
      "This store code matches more than one Google Business Profile location. In Settings, choose the location from the list under Google Business Profile, or paste its full resource name under Advanced, then retry.",
    ) as Error & { code: string };
    error.code = "GBP_STORE_CODE_NOT_UNIQUE";
    throw error;
  }

  return candidates[0].resourceName;
}
