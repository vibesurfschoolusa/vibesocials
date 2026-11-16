import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { refreshGoogleTokenEarly } from "@/server/platforms/googleTokens";
import {
  googleRefusedBody,
  listGbpLocations,
  refreshAccessToken,
  reviewsErrorBody,
  type ReviewsReader,
} from "@/server/googleReviews";
import { signedOutResponse } from "@/lib/signedOutResponse";

export const dynamic = "force-dynamic";

const LOCATIONS_FAILED_MESSAGE = "Couldn't load your Google locations. Try again in a minute.";

/**
 * GET /api/reviews/locations - Fetch all Google Business Profile locations
 * for the active workspace. Any member may read (Team Workspaces — same
 * member-level access as the rest of the reviews surface).
 */
export async function GET() {
  // R12 L1: who reads the answer. Until the context is read, nobody is offered a reconnect.
  let role: ReviewsReader = "member";
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return signedOutResponse();
    }
    role = context.role;

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

    // R23 client-journey L1: a token in its last 5 minutes is refreshed too,
    // so a long listing never runs past expiry (Google's 401 reads "Reconnect").
    // A failed early refresh of a still-valid token goes on with the stored one.
    // The shared refresh saves the new token itself.
    const accessToken = (await refreshGoogleTokenEarly(connection, refreshAccessToken)).accessToken;

    // The listing the reply route checks a review's location against (googleReviews.ts).
    const { locations } = await listGbpLocations(accessToken!);

    return NextResponse.json({
      locations,
      connected: true,
    });
  } catch (error: unknown) {
    console.error("[GBP Locations] Error:", error);
    return NextResponse.json(reviewsErrorBody(error, LOCATIONS_FAILED_MESSAGE, role), { status: 500 });
  }
}
