import { NextResponse } from "next/server";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { checkRateLimit } from "@/lib/rateLimit";
import { isExpiredTokenFailure, type GoogleFailureKind } from "@/server/googleFailure";
import type { TokenSnapshot } from "@/server/platforms/connectionHealth";
import { readGbpLocations, type GbpListing, type UnreadAccounts } from "@/server/platforms/gbpLocation";
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
 * locations is listed, and checked, in full everywhere. The reader lives in
 * platforms/gbpLocation.ts, beside the store-code lookup that reads it too.
 */

export { GBP_MAX_PAGES } from "@/server/platforms/gbpLocation";
export type { GbpListing, ListedGbpLocation, UnreadAccounts } from "@/server/platforms/gbpLocation";

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
/**
 * R26 client-journey L2: the same for a member of the workspace (the Reviews
 * page): only the owner can check what the connected Google account manages.
 */
export const GBP_SOME_ACCOUNTS_REFUSED_MEMBER_NOTICE =
  "Google refused access to some of the connected Google account's Business Profile accounts, so their locations aren't listed. The workspace owner can check in Google Business Profile that the account still manages them.";
/** The same, when Google failed for them instead (the picker's step). */
export const GBP_SOME_ACCOUNTS_FAILED_NOTICE =
  "Google didn't send the locations of some of your Business Profile accounts. Press Fetch locations from Google again in a minute to see them all.";
/** The same on the Reviews page, which has no Fetch button. */
export const GBP_SOME_ACCOUNTS_FAILED_REVIEWS_NOTICE =
  "Google didn't send the locations of some of your Business Profile accounts. Reload this page in a minute to see them all.";

/**
 * R27 new-customer L6: the picker's own failures, each with its step (the
 * form shows the route's `error` as it is).
 * No connection row: both picker routes answer 400 with it after a disconnect
 * in another tab; after a reload the card shows Connect.
 */
export const GBP_DISCONNECTED_MESSAGE =
  "Google Business Profile was disconnected, maybe in another tab. Reload this page, then connect it again.";
/** A row with no access token: the in-place sign-in (`signIn: true`) saves a new one. */
export const GBP_NO_SIGN_IN_SAVED_MESSAGE =
  "The Google sign-in for Business Profile wasn't saved, so its locations can't be listed. Sign in to Google again with the account that manages your listing.";
/** Our own failure while listing (a bug, the database): trying again may work. */
export const GBP_LIST_FAILED_MESSAGE =
  "Something went wrong while listing your Business Profile locations. Press Fetch locations from Google again in a minute.";

/**
 * R24 platform-clients L1: the grant is dead (the row is flagged, or Google
 * refused the token), so only a reconnect helps. `code` lets the form tell
 * it apart and show the card's Reconnect state; `signIn: true` keeps the
 * in-place sign-in, the Reconnect button's own URL.
 */
export const GBP_RECONNECT_MESSAGE = "Reconnect Google Business Profile in Settings, then try again.";
export const GBP_RECONNECT_CODE = CONNECTION_RECONNECT_REQUIRED_CODE;

/** The picker's listing: a failure is already its answer. */
export type GbpLocationList = Extract<GbpListing, { ok: true }> | { ok: false; response: NextResponse };

/**
 * The line about skipped accounts, each reason with its own step; null when
 * none were skipped. The failed step names the surface's own control; the
 * refused step names who can take it (a member reads the owner can).
 */
export function unreadAccountsNotice(
  unread: UnreadAccounts,
  surface: "picker" | "reviews" = "picker",
  role: "owner" | "member" = "owner",
): string | null {
  const parts = [
    unread.access ? (role === "member" ? GBP_SOME_ACCOUNTS_REFUSED_MEMBER_NOTICE : GBP_SOME_ACCOUNTS_REFUSED_NOTICE) : null,
    unread.failed
      ? surface === "reviews"
        ? GBP_SOME_ACCOUNTS_FAILED_REVIEWS_NOTICE
        : GBP_SOME_ACCOUNTS_FAILED_NOTICE
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * What an owner's location list adds to the locations (the picker and, since
 * R26 client-journey L3, the Reviews page): the skipped accounts' notice, or,
 * when nothing was skipped and nothing is listed, the no-listing notice with
 * the in-place sign-in (another Google account may manage the listing).
 */
export function listingNotice(
  listing: { locations: readonly unknown[]; unread: UnreadAccounts },
  surface: "picker" | "reviews",
): { notice?: string; signIn?: true } {
  const notice = unreadAccountsNotice(listing.unread, surface);
  if (notice) return { notice };
  if (listing.locations.length === 0) return { notice: GBP_NO_LISTING_NOTICE, signIn: true };
  return {};
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

/** One Google GET with the bearer token, under the shared request timeout. */
function googleGet(url: URL, accessToken: string): Promise<Response> {
  return fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

/**
 * The listing for a token the caller already holds (the Reviews routes, which
 * refresh it early first): `used` is the row it came from, with its stored
 * expiry. R26 platform-clients L1: a 401 on that token after it expired flags
 * nothing (googleFailure.ts flagIfTokenRejected) and is thrown, so the route's
 * withGoogleTokenRetry refreshes once and lists again.
 */
export async function listGbpLocationsWithToken(
  used: TokenSnapshot & { expiresAt?: Date | null },
  where: string,
): Promise<GbpListing> {
  const listing = await readGbpLocations({ where, get: (url) => googleGet(url, used.accessToken), used: () => used });
  if (!listing.ok && isExpiredTokenFailure(listing.failure)) throw listing.failure;
  return listing;
}

/**
 * The picker's listing (owner-only routes): one token refresh at most, on the
 * first 401 (an expired access token), and a failure already worded.
 */
export async function listGbpLocations(connection: SocialConnection): Promise<GbpLocationList> {
  if (!connection.accessToken) {
    return refused({ error: GBP_NO_SIGN_IN_SAVED_MESSAGE, signIn: true }, { status: 400 });
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
    return refused({ error: GBP_LIST_FAILED_MESSAGE }, { status: 500 });
  }
}
