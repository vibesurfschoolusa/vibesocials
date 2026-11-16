import { NextResponse } from "next/server";
import type { SocialConnection } from "@prisma/client";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { refreshGoogleTokenEarly } from "@/server/platforms/googleTokens";
import { flagIfTokenRejected, withGoogleTokenRetry } from "@/server/googleFailure";
import {
  MEMBER_NO_LOCATION_NOTICE,
  MEMBER_SAVED_NOT_LISTED_NOTICE,
  googleRefusedBody,
  refreshAccessToken,
  reviewsErrorBody,
  reviewsKindBody,
  reviewsListedLocation,
  savedCodeShared,
  savedCodeSharedNotice,
  savedLocationIn,
  savedLocationName,
  type ReviewsReader,
} from "@/server/googleReviews";
import {
  googleRouteRateLimit,
  listGbpLocationsWithToken,
  listingNotice,
  unreadAccountsNotice,
} from "@/app/api/connections/google_business_profile/gbpLocations";
import { signedOutResponse } from "@/lib/signedOutResponse";

export const dynamic = "force-dynamic";

const LOCATIONS_FAILED_MESSAGE = "Couldn't load your Google locations. Try again in a minute.";
const WHERE = "GET /api/reviews/locations";

/**
 * GET /api/reviews/locations - Fetch all Google Business Profile locations
 * for the active workspace. Any member may read (Team Workspaces — same
 * member-level access as the rest of the reviews surface).
 *
 * R25: the one paged listing the Settings picker uses (gbpLocations.ts), with
 * the same `notice` about accounts that could not be read. A member is served
 * only the workspace's saved location (client-journey L3); an owner, every one.
 */
export async function GET() {
  // R12 L1: who reads the answer. Until the context is read, nobody is offered a reconnect.
  let role: ReviewsReader = "member";
  // The row whose token the Google calls send: a token Google refuses is flagged with it.
  let used: SocialConnection | null = null;
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return signedOutResponse();
    }
    role = context.role;

    // R25 security-billing L1: before any Google call.
    const limited = await googleRouteRateLimit(context.user.id, "reviews/locations");
    if (limited) return limited;

    // Get the workspace's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        workspaceId: context.workspace.id,
        platform: "google_business_profile",
      },
    });

    // Not being connected yet is the normal state for a new workspace, not a
    // failure: the reviews page renders its red "Couldn't load reviews"
    // ErrorState (with a Retry that could never succeed) for any non-ok
    // response. Report it as an ordinary empty result and let the client show
    // the "Connect Google Business Profile" empty state instead.
    if (!connection) {
      return NextResponse.json({ locations: [], connected: false });
    }

    // A connection Google has revoked reads "Reconnect" at once, as the link
    // route does, instead of after the stored token runs out.
    if (connection.needsReconnect) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // R25 lead review: a member is served only the saved location, so with none
    // saved there is nothing to ask Google for.
    const savedName = savedLocationName(connection.metadata);
    if (role === "member" && !savedName) {
      return NextResponse.json({ locations: [], connected: true, notice: MEMBER_NO_LOCATION_NOTICE });
    }

    // R23 client-journey L1: a token in its last 5 minutes is refreshed too,
    // so a long listing never runs past expiry (Google's 401 reads "Reconnect").
    // A failed early refresh of a still-valid token goes on with the stored one.
    // The shared refresh saves the new token itself.
    used = await refreshGoogleTokenEarly(connection, refreshAccessToken);
    if (!used.accessToken) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // R26 platform-clients L1: a 401 on a token that ran out on the way is
    // refreshed once and the listing read once more (withGoogleTokenRetry).
    return await withGoogleTokenRetry(used, refreshAccessToken, async (row) => {
      used = row;
      // The listing the reply route checks a review's location against.
      const listing = await listGbpLocationsWithToken(
        { id: row.id, accessToken: row.accessToken ?? "", refreshToken: row.refreshToken ?? null, expiresAt: row.expiresAt },
        WHERE,
      );
      // No location is chosen here yet: an access refusal is about the account.
      if (!listing.ok) {
        return NextResponse.json(reviewsKindBody(listing.kind, LOCATIONS_FAILED_MESSAGE, role, { subject: "account" }), {
          status: 500,
        });
      }

      // R26 client-journey L2: a saved store code two listed locations share names neither.
      const shared = savedCodeShared(listing.locations, savedName) ? savedCodeSharedNotice(role) : null;
      if (role === "owner") {
        const locations = listing.locations.map(reviewsListedLocation);
        // R26 client-journey L3: the picker's notices, from the same helper (an
        // empty list says to sign in again, never to create a listing).
        const listed = listingNotice(listing, "reviews");
        const notice = [listed.notice, shared].filter(Boolean).join(" ");
        return NextResponse.json({ locations, connected: true, ...listed, ...(notice ? { notice } : {}) });
      }

      if (shared) return NextResponse.json({ locations: [], connected: true, notice: shared });
      const saved = savedLocationIn(listing.locations, savedName);
      if (saved) return NextResponse.json({ locations: [reviewsListedLocation(saved)], connected: true });
      // Not found: maybe on an account that could not be read; else not this login's.
      const notice = unreadAccountsNotice(listing.unread, "reviews", role);
      const memberNotice = !listing.complete && notice ? notice : MEMBER_SAVED_NOT_LISTED_NOTICE;
      return NextResponse.json({ locations: [], connected: true, notice: memberNotice });
    });
  } catch (error: unknown) {
    // R25 platform-clients L2: a token Google refused flags the row first.
    const settled = await flagIfTokenRejected(error, used);
    // Classified once, by kind (classifyGoogleFailure, via reviewsErrorBody).
    // No location is chosen here yet: an access refusal is about the account.
    const body = reviewsErrorBody(settled, LOCATIONS_FAILED_MESSAGE, role, {
      where: WHERE,
      subject: "account",
    });
    return NextResponse.json(body, { status: 500 });
  }
}
