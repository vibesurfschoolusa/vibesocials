import { NextResponse } from "next/server";
import type { SocialConnection } from "@prisma/client";
import { getWorkspaceContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { prisma } from "@/lib/db";
import { refreshGoogleTokenEarly } from "@/server/platforms/googleTokens";
import { flagIfTokenRejected, googleFailureKind, withGoogleTokenRetry } from "@/server/googleFailure";
import {
  MEMBER_OTHER_LOCATION_MESSAGE,
  googleRefusedBody,
  reviewsErrorBody,
  reviewsKindBody,
  savedLocationIn,
  savedLocationName,
  type ReviewsReader,
} from "@/server/googleReviews";
import { googleRouteRateLimit, listGbpLocationsWithToken } from "@/app/api/connections/google_business_profile/gbpLocations";
import { signedOutResponse } from "@/lib/signedOutResponse";

export const dynamic = "force-dynamic";

const REVIEWS_FAILED_MESSAGE = "Couldn't load your Google reviews. Try again in a minute.";
const WHERE = "GET /api/reviews";

/**
 * GET /api/reviews?location=... - Fetch Google Business Profile reviews for a
 * specific location. Any member may read (Team Workspaces — design §1:
 * "Reply to Google reviews" is member-level, and reading is a strict subset).
 * F7: every page Google has, up to REVIEWS_SHOWN_MAX (`truncated` when more);
 * errors are plain sentences (reviewsErrorBody).
 *
 * R25 client-journey L3: a member reads only the workspace's saved location
 * (an agency's Google login manages other clients' listings too); an owner
 * may read any location the login lists.
 */
export async function GET(request: Request) {
  // R12 L1: who reads the answer. Until the context is read, nobody is offered a reconnect.
  let role: ReviewsReader = "member";
  // JJ3 lead review: a removed location is worded by whether it is the saved one.
  let asked: { locationName: string; saved: string | null } | null = null;
  // The row whose token the Google calls send: a token Google refuses is flagged with it.
  let used: SocialConnection | null = null;
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return signedOutResponse();
    }
    role = context.role;

    // R27 (lead addition): the workspace the Reviews page was rendered for,
    // refused when it is not the active one, before any Google call (an
    // agency login lists every client's locations). No id is a page drawn
    // before the id was sent: it reads the active workspace until reloaded.
    const sent = new URL(request.url).searchParams.get("workspaceId");
    const refusal = sent === null ? null : renderedWorkspaceRefusal(sent, context.workspace.id);
    if (refusal) return refusal;

    // R25 security-billing L1: before any Google call.
    const limited = await googleRouteRateLimit(context.user.id, "reviews");
    if (limited) return limited;

    // Get location from query params
    const { searchParams } = new URL(request.url);
    const locationParam = searchParams.get("location");

    // Get the workspace's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        workspaceId: context.workspace.id,
        platform: "google_business_profile",
      },
    });

    if (!connection) {
      return NextResponse.json(
        { error: "No Google Business Profile connection found" },
        { status: 404 }
      );
    }

    // A connection Google has revoked reads "Reconnect" at once, as the link
    // route does, instead of after the stored token runs out.
    if (connection.needsReconnect) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // R23 client-journey L1: a token in its last 5 minutes is refreshed too,
    // so a long listing never runs past expiry (Google's 401 reads "Reconnect").
    // A failed early refresh of a still-valid token goes on with the stored one.
    const { refreshAccessToken } = await import("@/server/googleReviews");
    used = await refreshGoogleTokenEarly(connection, refreshAccessToken);

    if (!used.accessToken) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // Get location name from query param or metadata
    const saved = savedLocationName(connection.metadata);
    const locationName = locationParam || saved;

    if (!locationName) {
      return NextResponse.json(
        {
          error:
            "Please select a location to view reviews.",
        },
        { status: 400 }
      );
    }
    asked = { locationName, saved };

    // R26 platform-clients L1: a 401 on a token that ran out on the way is
    // refreshed once and the work retried once (withGoogleTokenRetry).
    return await withGoogleTokenRetry(used, refreshAccessToken, async (row) => {
      used = row;
      const accessToken = row.accessToken ?? "";
      if (role === "member" && locationName !== saved) {
        // A store code saved under Advanced is matched through the listing.
        let allowed = false;
        if (saved && !saved.startsWith("accounts/")) {
          const listing = await listGbpLocationsWithToken(
            { id: row.id, accessToken, refreshToken: row.refreshToken ?? null, expiresAt: row.expiresAt },
            WHERE,
          );
          if (!listing.ok) {
            return NextResponse.json(reviewsKindBody(listing.kind, REVIEWS_FAILED_MESSAGE, role), { status: 500 });
          }
          allowed = savedLocationIn(listing.locations, saved)?.resourceName === locationName;
        }
        if (!allowed) return NextResponse.json({ error: MEMBER_OTHER_LOCATION_MESSAGE }, { status: 403 });
      }

      // Fetch reviews from Google Business Profile API
      const { fetchAllReviews } = await import("@/server/googleReviews");
      const { reviews, truncated } = await fetchAllReviews(accessToken, locationName);

      return NextResponse.json({ reviews, truncated });
    });
  } catch (error: unknown) {
    // R25 platform-clients L2: a token Google refused flags the row first.
    const settled = await flagIfTokenRejected(error, used);
    const location =
      asked && used && googleFailureKind(settled) === "notFound" ? await removedLocationWas(role, asked, used) : "saved";
    // Classified once, by kind (classifyGoogleFailure, via reviewsErrorBody).
    const body = reviewsErrorBody(settled, REVIEWS_FAILED_MESSAGE, role, { where: WHERE, location });
    return NextResponse.json(body, { status: 500 });
  }
}

/**
 * R26 client-journey L1 / pages L5: whether a removed location is worded as
 * one picked on the page ("Pick another location above") or as the saved one
 * (Settings). Saved is decided by the resolved resource name, so a store code
 * saved under Advanced is the saved one when its listed match was asked for;
 * picked is said only to an owner, and only when the page shows its picker
 * (two or more locations listed). Read only on this failure; when the listing
 * can't be read, Settings is the step that always exists.
 */
async function removedLocationWas(
  role: ReviewsReader,
  asked: { locationName: string; saved: string | null },
  used: SocialConnection,
): Promise<"saved" | "picked"> {
  if (role === "member" || !used.accessToken || asked.locationName === asked.saved) return "saved";
  try {
    const listing = await listGbpLocationsWithToken(
      { id: used.id, accessToken: used.accessToken, refreshToken: used.refreshToken ?? null, expiresAt: used.expiresAt },
      WHERE,
    );
    if (!listing.ok) return "saved";
    if (savedLocationIn(listing.locations, asked.saved)?.resourceName === asked.locationName) return "saved";
    return listing.locations.length >= 2 ? "picked" : "saved";
  } catch {
    return "saved";
  }
}
