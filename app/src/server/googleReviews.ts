import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import {
  CONNECT_CALL_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_CODE,
  fetchWithinLimit,
} from "@/lib/fetchWithTimeout";

import { classifyGoogleFailure, googleErrorFields, type GoogleFailureKind } from "./googleFailure";
import { refreshConnectionToken } from "./platforms/connectionRefresh";
import { readGoogleErrorBody } from "./platforms/rateLimited";
import { resolveGbpLocationName } from "./platforms/gbpLocation";
import { isNeverConnectedFetchError } from "./platforms/transientRetry";
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

/**
 * assertOk, with Google's error reasons on the thrown error (`googleReasons`),
 * so reviewsErrorBody can tell one 403 from another (JJ3 lead review). R37:
 * and whether the body could be read at all (googleErrorFields): an unreadable
 * 403 reads "try again", never "Google refused access".
 */
async function assertGoogleOk(response: Response, options: Parameters<typeof assertOk>[1]): Promise<void> {
  if (response.ok) return;
  const fields = googleErrorFields(await readGoogleErrorBody(response));
  try {
    await assertOk(response, options);
  } catch (error) {
    throw Object.assign(error as Error, fields);
  }
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
  // R37 lead follow-up: bounded headers AND body, so a stalled answer is "try again".
  const response = await fetchWithinLimit(
    `https://mybusiness.googleapis.com/v4/${resolvedLocationName}/reviews${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    timeoutMs ?? CONNECT_CALL_TIMEOUT_MS
  );

  await assertGoogleOk(response, {
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

/**
 * What the Reviews page says when Google refused: its token is no longer
 * accepted. R25 lead review: an owner's answer always carries `signIn: true`,
 * and the page then shows Sign in to Google again (not Go to Settings), so the
 * sentence names that control.
 */
export const GOOGLE_REFUSED_MESSAGE =
  "Google refused the request. Sign in to Google again with the account that manages this listing.";
/** R12 L1: the same for a member, who can read and reply but not reconnect. */
export const GOOGLE_REFUSED_MEMBER_MESSAGE =
  "Google refused the request. The workspace owner can reconnect Google Business Profile.";

/** Who reads a Reviews answer: the role from the route's workspace context. */
export type ReviewsReader = "owner" | "member";

/**
 * A refusal, for whoever reads it. Only an owner's carries `reconnect: true`
 * (the page then links to Settings): a member's Settings is read-only. R25: an
 * owner's also carries `signIn: true`, the in-place sign-in, which is the
 * Reconnect button's own URL (lib/gbpSignIn.ts).
 */
export function googleRefusedBody(role: ReviewsReader): ReviewsErrorBody {
  return role === "member"
    ? { error: GOOGLE_REFUSED_MEMBER_MESSAGE }
    : { error: GOOGLE_REFUSED_MESSAGE, reconnect: true, signIn: true };
}

/**
 * R25 client-journey L3: with an agency's Google login, a member serves only
 * the workspace's own saved location (403). Owners may read any listed one.
 */
export const MEMBER_OTHER_LOCATION_MESSAGE =
  "Members read and answer the reviews of this workspace's own Google location only. The workspace owner chooses that location.";
/** A member, and no saved location this login lists: who can choose one. */
export const MEMBER_NO_LOCATION_NOTICE =
  "The workspace owner hasn't chosen this workspace's Google location yet. Its reviews show here once they have.";
/** A member, and the saved location is not one this login lists (a complete list). */
export const MEMBER_SAVED_NOT_LISTED_NOTICE =
  "This workspace's saved Google location isn't one the connected Google account manages. The workspace owner can choose the location again.";

/** Why GET /api/reviews/link has no link for the "Get more reviews" panel. */
export type ReviewLinkProblem =
  | "not_connected"
  | "no_location"
  | "needs_reconnect"
  | "location_removed"
  | "google_has_none";

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
    // An owner's needs_reconnect answer always carries `signIn: true` (link route): the sentence names that button.
    owner:
      "Google no longer accepts this connection. Sign in to Google again with the account that manages this listing to get your review link.",
    member: "The workspace owner can reconnect Google Business Profile; then the review link shows here.",
  },

  location_removed: {
    owner: "This location is no longer in Google Business Profile. Choose another location in Settings.",
    member: "This location is no longer in Google Business Profile. The workspace owner can choose another location.",
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

/**
 * JJ3 lead review: what the Reviews page says for each kind of Google failure
 * (server/googleFailure.ts decides the kind), for an owner or a member.
 *
 * access: the connected Google account no longer manages what was asked for.
 * The sentence is about the location being read, or about the Business Profile
 * account where no location is chosen yet (GET /api/reviews/locations). R25
 * client-journey L1: the owner's step is the in-place sign-in (`signIn: true`)
 * with the account that does manage it, which keeps the row, its numbers and
 * the location (saveConnection.ts); never Switch account, which deletes them.
 */
export const GOOGLE_ACCESS_REFUSED_MESSAGE =
  "Google refused access to this location: the connected Google account may no longer manage it. Sign in to Google again with the account that manages this location.";
export const GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE =
  "Google refused access to this location: the connected Google account may no longer manage it. The workspace owner can sign in to Google again with the account that manages it.";
const GOOGLE_ACCOUNT_REFUSED_MESSAGE =
  "Google refused access to this Business Profile account: the connected Google account may no longer manage your business. Sign in to Google again with the account that manages your business.";
const GOOGLE_ACCOUNT_REFUSED_MEMBER_MESSAGE =
  "Google refused access to this Business Profile account: the connected Google account may no longer manage your business. The workspace owner can sign in to Google again with the account that manages it.";
/** chooseAgain (R25 platform-clients L3): retrying never helps; choosing the location again does. */
const STORE_CODE_STALE_MESSAGE =
  "The saved store code no longer matches one Google Business Profile location. Choose the location again in Settings.";
const STORE_CODE_STALE_MEMBER_MESSAGE =
  "The saved store code no longer matches one Google Business Profile location. The workspace owner can choose the location again.";
/** reviewGone (R25 pages L5): the review was deleted on Google, so no reply can be posted. */
const REVIEW_GONE_MESSAGE = "This review is no longer on Google. Reload the page.";
/**
 * notFound, for a location an owner picked on the Reviews page (not saved):
 * the page's own picker, which shows only with two or more locations listed.
 */
const LOCATION_GONE_PICKED_MESSAGE =
  "This location is no longer in Google Business Profile. Pick another location above.";
/** notFound, for the saved location (Settings, where Google posts go too). */
const LOCATION_GONE_SAVED_MESSAGE =
  "This location is no longer in Google Business Profile. Choose another location in Settings (it's also where your Google posts go).";
/** R26 client-journey L1: a member has no picker (they read the saved location only). */
const LOCATION_GONE_MEMBER_MESSAGE =
  "This location is no longer in Google Business Profile. The workspace owner can choose another location.";
/** Google or our own setup failed, not the person: the same words for everyone. */
export const GOOGLE_NOT_ANSWERING_MESSAGE =
  "Google Business Profile isn't answering for Vibe Socials right now. Try again later.";

/** What an access refusal is about: a chosen location, or the account (no location chosen yet). */
export type AccessSubject = "location" | "account";

/** The access sentence, for whoever reads it. */
export function googleAccessRefusedMessage(subject: AccessSubject, role: ReviewsReader): string {
  if (subject === "account") {
    return role === "member" ? GOOGLE_ACCOUNT_REFUSED_MEMBER_MESSAGE : GOOGLE_ACCOUNT_REFUSED_MESSAGE;
  }
  return role === "member" ? GOOGLE_ACCESS_REFUSED_MEMBER_MESSAGE : GOOGLE_ACCESS_REFUSED_MESSAGE;
}

/**
 * A Reviews route's error answer. `signIn`: an owner's answer asks for the
 * in-place sign-in; the page builds its URL from its own workspace
 * (lib/gbpSignIn.ts), so no URL is ever sent.
 */
export interface ReviewsErrorBody {
  error: string;
  reconnect?: true;
  signIn?: true;
}

/** The chooseAgain sentence, for whoever reads it (the Reviews routes and the link panel). */
export function storeCodeStaleMessage(role: ReviewsReader): string {
  return role === "member" ? STORE_CODE_STALE_MEMBER_MESSAGE : STORE_CODE_STALE_MESSAGE;
}

/**
 * R25 lead review: the codes of the reply failures a retry can't change. The
 * reply route adds the kind's code (status and text unchanged), so the page
 * closes the confirm dialog and keeps the sentence and any link in the form.
 * Try-later and the route's fallback carry none: sending again may work.
 * components/reviews/api-error.ts repeats the values (client code); a test
 * keeps the two equal.
 */
export const REPLY_FINAL_CODES = {
  // connectionRefresh.ts CONNECTION_RECONNECT_REQUIRED_CODE, the code the picker routes send too.
  reconnect: "RECONNECT_REQUIRED",
  access: "GBP_ACCESS_REFUSED",
  notFound: "GBP_LOCATION_GONE",
  chooseAgain: "GBP_CHOOSE_LOCATION_AGAIN",
  reviewGone: "GBP_REVIEW_GONE",
} as const satisfies Partial<Record<GoogleFailureKind, string>>;

/** The reply route's answer for a kind: the Reviews answer, plus the kind's code when a retry can't change it. */
export function replyErrorBody(
  kind: GoogleFailureKind,
  fallback: string,
  role: ReviewsReader,
): ReviewsErrorBody & { code?: string } {
  const body = reviewsKindBody(kind, fallback, role);
  const code = (REPLY_FINAL_CODES as Partial<Record<GoogleFailureKind, string>>)[kind];
  return code ? { ...body, code } : body;
}

/** An owner's answer carries `reconnect: true`: the page links to Settings, where the step is. */
function ownerStep(role: ReviewsReader, owner: string, member: string): ReviewsErrorBody {
  return role === "member" ? { error: member } : { error: owner, reconnect: true };
}

type ReviewsErrorOptions = { where?: string; subject?: AccessSubject; location?: "saved" | "picked" };

/**
 * The error body the Reviews routes answer with (F7, R1 M5): the kind of the
 * failure (classifyGoogleFailure, which writes its one classification line),
 * worded for the page (reviewsKindBody).
 */
export function reviewsErrorBody(
  error: unknown,
  fallback: string,
  role: ReviewsReader,
  options: ReviewsErrorOptions = {},
): ReviewsErrorBody {
  return reviewsKindBody(classifyGoogleFailure(error, options.where ?? "Reviews"), fallback, role, options);
}

/**
 * A kind of Google failure, worded for the Reviews page. `reconnect: true`
 * (the page then links to the Google Business Profile card in Settings) goes
 * only to an owner, and so does `signIn: true` (the in-place sign-in, never a
 * URL), on the reconnect and access answers. `fallback` is the route's own
 * sentence for anything else: an error's own text is never shown. `location`
 * says whether a removed location was the saved one ("saved", the default) or
 * one picked on the Reviews page ("picked", not saved).
 */
export function reviewsKindBody(
  kind: GoogleFailureKind,
  fallback: string,
  role: ReviewsReader,
  options: ReviewsErrorOptions = {},
): ReviewsErrorBody {
  switch (kind) {
    case "reconnect":
      return googleRefusedBody(role);
    case "access": {
      const subject = options.subject ?? "location";
      const body = ownerStep(role, googleAccessRefusedMessage(subject, "owner"), googleAccessRefusedMessage(subject, "member"));
      return role === "owner" ? { ...body, signIn: true } : body;
    }
    case "notFound":
      return options.location === "picked" && role === "owner"
        ? { error: LOCATION_GONE_PICKED_MESSAGE }
        : ownerStep(role, LOCATION_GONE_SAVED_MESSAGE, LOCATION_GONE_MEMBER_MESSAGE);
    case "chooseAgain":
      return ownerStep(role, storeCodeStaleMessage("owner"), storeCodeStaleMessage("member"));
    case "reviewGone":
      return { error: REVIEW_GONE_MESSAGE };
    case "tryLater":
      return { error: GOOGLE_NOT_ANSWERING_MESSAGE };
    default:
      return { error: fallback };
  }
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

/** A location as GET /api/reviews/locations lists it (from the shared listing, gbpLocations.ts). */
export interface GbpListedLocation {
  /** Full resource name: accounts/.../locations/... */
  name: string;
  locationName: string;
  title: string;
  storeCode?: string;
  /** One-line address: the picker tells same-named branches apart by it (components/reviews/location-labels.ts). */
  address?: string;
}

/** The fields of a listed location the Reviews routes read (gbpLocations.ts ListedGbpLocation). */
interface ListedLocationFields {
  resourceName: string;
  title: string | null;
  storeCode: string | null;
  address?: string | null;
}

/** A listed location in the shape the Reviews page reads (R26 client-journey L4: with its address). */
export function reviewsListedLocation(location: ListedLocationFields): GbpListedLocation {
  const title = location.title || "Unknown Location";
  return {
    name: location.resourceName,
    locationName: title,
    title,
    ...(location.storeCode ? { storeCode: location.storeCode } : {}),
    ...(location.address ? { address: location.address } : {}),
  };
}

/**
 * True when the saved location is a store code more than one listed location
 * has (R26 client-journey L2): savedLocationIn names none of them, and every
 * post to it fails as not unique.
 */
export function savedCodeShared(locations: ListedLocationFields[], saved: string | null | undefined): boolean {
  const name = typeof saved === "string" ? saved.trim() : "";
  if (!name || locations.some((location) => location.resourceName === name)) return false;
  return locations.filter((location) => location.storeCode === name).length > 1;
}

const SAVED_CODE_SHARED_NOTICE =
  "This workspace's saved store code matches more than one Google location, so its reviews can't be told apart. Choose the location from the list in Settings.";
const SAVED_CODE_SHARED_MEMBER_NOTICE =
  "This workspace's saved store code matches more than one Google location, so its reviews can't be told apart. The workspace owner can choose the location from the list.";

/** The shared-store-code sentence, for whoever reads it. */
export function savedCodeSharedNotice(role: ReviewsReader): string {
  return role === "member" ? SAVED_CODE_SHARED_MEMBER_NOTICE : SAVED_CODE_SHARED_NOTICE;
}

/**
 * The saved location's entry in a listing (Settings saves a resource name, or
 * a store code typed under Advanced), or null. A store code more than one
 * location has names none of them.
 */
export function savedLocationIn<T extends ListedLocationFields>(locations: T[], saved: string | null | undefined): T | null {
  const name = typeof saved === "string" ? saved.trim() : "";
  if (!name) return null;
  const byName = locations.find((location) => location.resourceName === name);
  if (byName) return byName;
  const byCode = locations.filter((location) => location.storeCode === name);
  return byCode.length === 1 ? byCode[0] : null;
}

/** The saved location as Settings stored it in the connection's metadata, or null. */
export function savedLocationName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { locationName } = metadata as Record<string, unknown>;
  return typeof locationName === "string" && locationName.trim() !== "" ? locationName.trim() : null;
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

  const response = await fetchWithinLimit(
    `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${encodeURIComponent(locationId)}?readMask=metadata.newReviewUri`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    CONNECT_CALL_TIMEOUT_MS
  );
  await assertGoogleOk(response, {
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
 * R48 platform: the reply's PUT was sent and its outcome is unknown (a timeout,
 * a connection that dropped after connecting, a 5xx, a 2xx body that never
 * ended), so Google may have saved it. Not "try later": the sentence says it may be
 * posted, and that posting again replaces it (a PUT), so the person knows what
 * a second press does.
 */
export const GBP_REPLY_UNCONFIRMED_CODE = "GBP_REPLY_UNCONFIRMED";
export const REPLY_MAY_BE_POSTED_MESSAGE =
  "Google's answer didn't arrive, so your reply may have been posted. Press Post reply again: it replaces any reply already posted, so it won't post twice.";

function replyUnconfirmedError(cause: unknown): Error & { code: typeof GBP_REPLY_UNCONFIRMED_CODE } {
  return Object.assign(new Error(REPLY_MAY_BE_POSTED_MESSAGE, { cause }), { code: GBP_REPLY_UNCONFIRMED_CODE } as const);
}

/** A failure of the sent PUT that says nothing about whether Google saved it. */
function replyMayHaveLanded(error: unknown): boolean {
  if (error instanceof TypeError) return !isNeverConnectedFetchError(error);
  return (error as { code?: unknown } | null)?.code === FETCH_TIMEOUT_CODE;
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
  // R48: the limit covers the answer's body too.
  let response: Response;
  try {
    response = await fetchWithinLimit(
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
      },
      DEFAULT_FETCH_TIMEOUT_MS
    );
  } catch (error) {
    throw replyMayHaveLanded(error) ? replyUnconfirmedError(error) : error;
  }

  // A 5xx after the PUT was sent says nothing about whether Google saved it:
  // the same uncertain outcome as a lost answer. A 4xx is a certain refusal.
  if (response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    throw replyUnconfirmedError(Object.assign(new Error(`Reply answered HTTP ${response.status}`), { status: response.status }));
  }

  await assertGoogleOk(response, {
    code: "GBP_REVIEWS_REPLY_FAILED",
    prefix: "Failed to post Google Business Profile review reply",
  });

  // Google answered 2xx, so the reply is saved: an answer we cannot read is
  // unconfirmed, never a failure that reads "try later".
  let data: { comment: string; updateTime: string };
  try {
    data = (await response.json()) as { comment: string; updateTime: string };
  } catch (error) {
    throw replyUnconfirmedError(error);
  }

  console.log("[GBP Reviews] Reply posted successfully");

  return data;
}
