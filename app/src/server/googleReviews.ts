import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

import { isTerminalRefreshFailure } from "./platforms/connectionHealth";
import { refreshConnectionToken } from "./platforms/connectionRefresh";
import { resolveGbpLocationName } from "./platforms/gbpLocation";
import { refreshGoogleToken } from "./platforms/googleTokens";

/**
 * Google Business Profile Review type
 */
export interface GoogleReview {
  name: string; // Full resource name (e.g., "accounts/.../locations/.../reviews/...")
  reviewId: string; // Extracted review ID
  reviewer: {
    profilePhotoUrl?: string;
    displayName: string;
    isAnonymous: boolean;
  };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
  };
}

/**
 * Refresh Google Business Profile access token.
 *
 * Thin wrapper over the shared `refreshGoogleToken` helper
 * (src/server/platforms/googleTokens.ts). The exported signature is preserved
 * because the reviews API routes import this by name. The helper updates ONLY
 * accessToken + expiresAt (never refreshToken) and throws
 * `GOOGLE_TOKEN_REFRESH_FAILED` on a non-2xx (previously
 * `GBP_REVIEWS_TOKEN_REFRESH_FAILED`); the reviews routes surface
 * `error.message`, not `.code`, so the code change is non-breaking.
 *
 * 2026-11-01 scale audit (jobs, token refresh): runs under the per-connection
 * lock (connectionRefresh.ts). If a publish, the health sweep or the metrics
 * sync refreshed the connection first, its row is returned and no second
 * refresh is sent. A connection that is gone or already flagged throws
 * `CONNECTION_GONE` / `RECONNECT_REQUIRED`, whose messages the routes surface.
 */
export async function refreshAccessToken(
  connection: SocialConnection
): Promise<SocialConnection> {
  return refreshConnectionToken(connection, (current) => refreshGoogleToken(current));
}

type GoogleReviewPayload = Omit<GoogleReview, "reviewId" | "reviewer"> & {
  reviewer?: Partial<GoogleReview["reviewer"]>;
};

/** The words for a reviewer Google gives no name for (as the new-review email says). */
const NAMELESS_REVIEWER = "A Google user";

/**
 * R19 client-journey: Google fills displayName only when the reviewer is not
 * anonymous, so it can be missing. Made a trimmed string here, where reviews
 * come in, so the card's initial, the AI draft and the email always have a name.
 */
function reviewerOf(reviewer: GoogleReviewPayload["reviewer"]): GoogleReview["reviewer"] {
  const name = typeof reviewer?.displayName === "string" ? reviewer.displayName.trim() : "";
  return { ...reviewer, displayName: name || NAMELESS_REVIEWER, isAnonymous: reviewer?.isAnonymous === true };
}

/** One page of a location's reviews: `query` is the list call's query string. */
async function fetchReviewsPage(
  accessToken: string,
  resolvedLocationName: string,
  query: string,
  timeoutMs?: number
): Promise<{ reviews: GoogleReview[]; nextPageToken: string | null }> {
  // Use Google My Business API v4 to fetch reviews
  // API: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list
  const response = await fetchWithTimeout(
    `https://mybusiness.googleapis.com/v4/${resolvedLocationName}/reviews${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    timeoutMs
  );

  await assertOk(response, {
    code: "GBP_REVIEWS_FETCH_FAILED",
    prefix: "Failed to fetch Google Business Profile reviews",
  });

  const data = (await response.json()) as {
    reviews?: GoogleReviewPayload[];
    nextPageToken?: unknown;
  };

  const reviews = (data.reviews || []).map((review) => ({
    ...review,
    reviewer: reviewerOf(review.reviewer),
    // Extract review ID from name (e.g., "accounts/.../locations/.../reviews/ABC123")
    reviewId: review.name.split("/").pop() || "",
  }));
  const nextPageToken =
    typeof data.nextPageToken === "string" && data.nextPageToken !== "" ? data.nextPageToken : null;
  return { reviews, nextPageToken };
}

/**
 * Fetch reviews for a Google Business Profile location (first page only).
 *
 * `newestFirst` (2026-11-10, the new review email) asks for the largest page
 * (50) ordered `updateTime desc`, the only newest-first order Google offers
 * (rating, rating desc, updateTime desc). A review's updateTime is never before
 * its createTime, so every review created since the last daily check is on that
 * page unless more than 50 reviews were created or edited in between.
 */
export async function fetchReviews(
  accessToken: string,
  locationName: string,
  options: { newestFirst?: boolean; timeoutMs?: number } = {}
): Promise<GoogleReview[]> {
  console.log("[GBP Reviews] Fetching reviews", { locationName });

  // Resolve location name if it's a store code. The shared helper returns a
  // full "accounts/.../locations/..." resource name as-is and resolves a Store
  // code via the account/location listing.
  const resolvedLocationName = await resolveGbpLocationName(
    accessToken,
    locationName
  );

  const query = options.newestFirst
    ? `?pageSize=50&orderBy=${encodeURIComponent("updateTime desc")}`
    : "";
  const { reviews } = await fetchReviewsPage(accessToken, resolvedLocationName, query, options.timeoutMs);

  console.log("[GBP Reviews] Fetched reviews successfully", {
    count: reviews.length,
  });

  return reviews;
}

/** The most reviews the Reviews page loads: ten of Google's largest pages. */
export const REVIEWS_SHOWN_MAX = 500;
const REVIEWS_PAGE_SIZE = 50;

/**
 * Every review of a location, newest first, for the Reviews page (F7, R1 M4:
 * the first page alone hid older reviews still waiting for a reply). Follows
 * `nextPageToken` up to REVIEWS_SHOWN_MAX reviews; `truncated` says Google had
 * more, so the page can say it shows only the latest ones.
 */
export async function fetchAllReviews(
  accessToken: string,
  locationName: string
): Promise<{ reviews: GoogleReview[]; truncated: boolean }> {
  const resolvedLocationName = await resolveGbpLocationName(accessToken, locationName);
  const reviews: GoogleReview[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  for (;;) {
    const params = new URLSearchParams({ pageSize: String(REVIEWS_PAGE_SIZE), orderBy: "updateTime desc" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await fetchReviewsPage(accessToken, resolvedLocationName, `?${params.toString()}`);
    reviews.push(...page.reviews);

    if (reviews.length > REVIEWS_SHOWN_MAX) {
      return { reviews: reviews.slice(0, REVIEWS_SHOWN_MAX), truncated: true };
    }
    // A token seen before would read the same pages again, for ever.
    if (!page.nextPageToken || seenTokens.has(page.nextPageToken)) {
      return { reviews, truncated: false };
    }
    if (reviews.length === REVIEWS_SHOWN_MAX) return { reviews, truncated: true };
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

/** What the Reviews page says when Google refused: its token is no longer accepted. */
export const GOOGLE_REFUSED_MESSAGE =
  "Google refused the request. Reconnect Google Business Profile in Settings.";
/** R12 L1: the same for a member, who can read and reply but not reconnect. */
export const GOOGLE_REFUSED_MEMBER_MESSAGE =
  "Google refused the request. The workspace owner can reconnect Google Business Profile.";

/** Who reads a Reviews answer: the role from the route's workspace context. */
export type ReviewsReader = "owner" | "member";

/**
 * A refusal, for whoever reads it. Only an owner's carries `reconnect: true`
 * (the page then links to Settings): a member's Settings is read-only.
 */
export function googleRefusedBody(role: ReviewsReader): { error: string; reconnect?: true } {
  return role === "member" ? { error: GOOGLE_REFUSED_MEMBER_MESSAGE } : { error: GOOGLE_REFUSED_MESSAGE, reconnect: true };
}

/** Why GET /api/reviews/link has no link for the "Get more reviews" panel. */
export type ReviewLinkProblem = "not_connected" | "no_location" | "needs_reconnect" | "google_has_none";

const REVIEW_LINK_REASONS: Record<ReviewLinkProblem, Record<ReviewsReader, string>> = {
  not_connected: {
    owner: "Connect Google Business Profile in Settings, Connections to get your review link.",
    member: "The workspace owner can connect Google Business Profile; then the review link shows here.",
  },
  no_location: {
    owner: "Choose your Maps location for Google Business Profile in Settings, Connections to get your review link.",
    member:
      "The workspace owner can choose the Maps location for Google Business Profile; then the review link shows here.",
  },
  needs_reconnect: {
    owner: "Reconnect Google Business Profile in Settings, Connections to get your review link.",
    member: "The workspace owner can reconnect Google Business Profile; then the review link shows here.",
  },
  google_has_none: {
    owner:
      "Google has no review link for this location yet. Check that the listing is verified in Google Business Profile, then reload this page.",
    member:
      "Google has no review link for this location yet. The workspace owner can check that the listing is verified in Google Business Profile.",
  },
};

/** The panel's one line on what to do, worded for who reads it (R12 L1: members may read the panel). */
export function reviewLinkReason(problem: ReviewLinkProblem, role: ReviewsReader): string {
  return REVIEW_LINK_REASONS[problem][role];
}

/** What the Reviews page says when our own Google setup, not the person's grant, failed. */
export const REVIEWS_UNAVAILABLE_MESSAGE = "Google Reviews are not available right now. Try again later.";

const RECONNECT_CODES = new Set(["RECONNECT_REQUIRED", "CONNECTION_GONE", "GOOGLE_NO_REFRESH_TOKEN"]);
const REFRESH_FAILED_CODE = "GOOGLE_TOKEN_REFRESH_FAILED";

/**
 * The error body the reviews routes answer with (F7, R1 M5). A reconnect is
 * asked for, with `reconnect: true` so the page links to Settings, only when
 * the person's Google grant is the problem: a 401/403 from a Google API call,
 * a connection already flagged or gone, no refresh token, or a refresh failure
 * that flags the row. JJ3 lead review: that last one is decided by the rule
 * that flags it (connectionHealth.ts isTerminalRefreshFailure: a 400 or 401,
 * or invalid_grant, but never invalid_client, 429 or 5xx), so a flagged row
 * never reads "not available" here while Settings shows Reconnect. A failure of
 * the app's own setup (missing OAuth credentials, invalid_client) says Reviews
 * are not available. Anything else is the route's plain `fallback`: an error's
 * own text is never shown.
 *
 * `oauthError` is the token endpoint's OAuth code when the thrown error carries
 * it. The GBP location picker uses this too (gbpLocations.ts).
 * `role` is the route's workspace context's: a member reads who can reconnect
 * (googleRefusedBody).
 */
export function reviewsErrorBody(
  error: unknown,
  fallback: string,
  role: ReviewsReader,
): { error: string; reconnect?: true } {
  const { status, code, oauthError } = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    oauthError?: unknown;
  };
  const refused = googleRefusedBody(role);
  const unavailable = { error: REVIEWS_UNAVAILABLE_MESSAGE };

  if (code === "GOOGLE_MISSING_OAUTH_CREDENTIALS") return unavailable;
  if (code === REFRESH_FAILED_CODE) {
    const oauth = typeof oauthError === "string" ? oauthError : undefined;
    if (oauth === "invalid_client") return unavailable;
    // No status passed on: only the OAuth code can say the grant is dead.
    if (isTerminalRefreshFailure(typeof status === "number" ? status : 0, oauth)) return refused;
    return { error: fallback };
  }
  if (status === 401 || status === 403) return refused;
  if (typeof code === "string" && RECONNECT_CODES.has(code)) return refused;
  return { error: fallback };
}

/**
 * The `accounts/{a}/locations/{l}` of a review's full resource name,
 * `accounts/{a}/locations/{l}/reviews/{r}` and nothing more, else null. The
 * reply is sent to `<name>/reply`, so an extra segment, a dot segment, an
 * escape or a query would point the request somewhere else. The ids
 * themselves are Google's, so any other character is left to Google to judge.
 */
export function reviewLocationName(name: string): string | null {
  const match = /^(accounts\/([^/?#%\s]+)\/locations\/([^/?#%\s]+))\/reviews\/([^/?#%\s]+)$/.exec(name);
  if (!match) return null;
  return match.slice(2).every((segment) => segment !== "." && segment !== "..") ? match[1] : null;
}

/** A location as GET /api/reviews/locations lists it. */
export interface GbpListedLocation {
  /** Full resource name: accounts/.../locations/... */
  name: string;
  locationName: string;
  title: string;
  storeCode?: string;
}

const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

/**
 * Every location the connection's Google account can manage, as the Reviews
 * page lists them; the reply route checks a review's location against the same
 * list (F7). Throws, with Google's `status`, when the accounts call fails. An
 * account whose locations could not be read is logged and left out, and
 * `complete` is false, so a caller can tell "not listed" from "not read".
 */
export async function listGbpLocations(
  accessToken: string
): Promise<{ locations: GbpListedLocation[]; complete: boolean }> {
  const accountsResponse = await fetch(`${ACCOUNT_MANAGEMENT_BASE}/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!accountsResponse.ok) {
    const errorText = await accountsResponse.text();
    console.error("[GBP Locations] Failed to fetch accounts:", {
      status: accountsResponse.status,
      statusText: accountsResponse.statusText,
      body: errorText.substring(0, 500),
    });
    // The status decides what the page says (reviewsErrorBody).
    throw Object.assign(new Error("Failed to fetch Google Business Profile accounts"), {
      status: accountsResponse.status,
    });
  }

  const accountsData = await accountsResponse.json();
  const accounts: Array<{ name?: string }> = accountsData.accounts || [];
  const allLocations: GbpListedLocation[] = [];
  let complete = true;

  for (const account of accounts) {
    const accountName = account.name;
    if (!accountName) continue;

    // Use the business information API with readMask to get location details
    const url = new URL(`${BUSINESS_INFO_BASE}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,storeCode,title");

    const locationsResponse = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (locationsResponse.ok) {
      const locationsData = await locationsResponse.json();
      const locations = locationsData.locations || [];

      for (const location of locations) {
        // Ensure we have the full resource name (accounts/.../locations/...)
        // The API might return just "locations/..." so we need to construct the full path
        let fullName = location.name;
        if (fullName && fullName.startsWith("locations/") && !fullName.includes("accounts/")) {
          fullName = `${accountName}/${fullName}`;
        }

        allLocations.push({
          name: fullName, // Full resource name: accounts/.../locations/...
          locationName: location.locationName || location.title || "Unknown Location",
          title: location.title || location.locationName || "Unknown Location",
          storeCode: location.storeCode,
        });
      }
    } else {
      complete = false;
      console.error("[GBP Locations] Failed to fetch locations for account", {
        accountName,
        status: locationsResponse.status,
      });
    }
  }

  console.log("[GBP Locations] Found locations:", allLocations.length);
  return { locations: allLocations, complete };
}

/** The location id of `accounts/{a}/locations/{l}` or `locations/{l}`, or null. */
export function locationIdOf(resourceName: string): string | null {
  const match = /(?:^|\/)locations\/([^/]+)$/.exec(resourceName);
  return match ? match[1] : null;
}

/**
 * The review link saved on a connection's metadata, or null. `newReviewUriFor`
 * names the location it was read for: a link saved before another location was
 * chosen belongs to the old one and counts as missing.
 */
export function savedNewReviewUri(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { locationName, newReviewUri, newReviewUriFor } = metadata as Record<string, unknown>;
  if (typeof newReviewUri !== "string" || newReviewUri === "") return null;
  if (typeof locationName !== "string" || locationName.trim() === "") return null;
  return newReviewUriFor === locationName.trim() ? newReviewUri : null;
}

/**
 * The link where a customer leaves a review for the location (2026-11-10, the
 * "Get more reviews" panel): Business Information API `metadata.newReviewUri`,
 * read with `readMask=metadata.newReviewUri` (scope business.manage, which the
 * connection holds). Null when Google gives none, or anything but an https link,
 * since it is shown as a link and drawn as a QR code. Throws on a refusal.
 */
export async function fetchNewReviewUri(
  accessToken: string,
  locationName: string
): Promise<string | null> {
  const resourceName = await resolveGbpLocationName(accessToken, locationName);
  const locationId = locationIdOf(resourceName);
  if (!locationId) return null;

  const response = await fetchWithTimeout(
    `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${encodeURIComponent(locationId)}?readMask=metadata.newReviewUri`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    15_000
  );
  await assertOk(response, {
    code: "GBP_REVIEW_LINK_FETCH_FAILED",
    prefix: "Failed to read the Google review link",
  });

  const body = (await response.json().catch(() => null)) as {
    metadata?: { newReviewUri?: unknown };
  } | null;
  const uri = body?.metadata?.newReviewUri;
  if (typeof uri !== "string" || uri.length > 2048) return null;
  try {
    return new URL(uri).protocol === "https:" ? uri : null;
  } catch {
    return null;
  }
}

/**
 * Reply to a Google Business Profile review
 */
export async function replyToReview(
  accessToken: string,
  reviewName: string,
  comment: string
): Promise<{ comment: string; updateTime: string }> {
  console.log("[GBP Reviews] Replying to review", { reviewName });

  // Use Google My Business API v4 to reply to review
  // API: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply
  // reviewName should be the full path: "accounts/.../locations/.../reviews/..."
  const response = await fetchWithTimeout(
    `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment,
      }),
    }
  );

  await assertOk(response, {
    code: "GBP_REVIEWS_REPLY_FAILED",
    prefix: "Failed to post Google Business Profile review reply",
  });

  const data = (await response.json()) as {
    comment: string;
    updateTime: string;
  };

  console.log("[GBP Reviews] Reply posted successfully");

  return data;
}
