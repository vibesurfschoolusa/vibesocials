import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { listGbpLocations, refreshAccessToken, reviewsErrorBody } from "@/server/googleReviews";

export const dynamic = "force-dynamic";

const LOCATIONS_FAILED_MESSAGE = "Couldn't load your Google locations. Try again in a minute.";

/**
 * GET /api/reviews/locations - Fetch all Google Business Profile locations
 * for the active workspace. Any member may read (Team Workspaces — same
 * member-level access as the rest of the reviews surface).
 */
export async function GET() {
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    // Check if token is expired and refresh if needed
    const now = new Date();
    let accessToken = connection.accessToken;

    if (connection.expiresAt && new Date(connection.expiresAt) <= now) {
      console.log("[GBP Locations] Access token expired, refreshing...");
      const refreshedConnection = await refreshAccessToken(connection);
      await prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: refreshedConnection.accessToken,
          expiresAt: refreshedConnection.expiresAt,
        },
      });
      accessToken = refreshedConnection.accessToken!;
    }

    // The listing the reply route checks a review's location against (googleReviews.ts).
    const { locations } = await listGbpLocations(accessToken!);

    return NextResponse.json({
      locations,
      connected: true,
    });
  } catch (error: unknown) {
    console.error("[GBP Locations] Error:", error);
    return NextResponse.json(reviewsErrorBody(error, LOCATIONS_FAILED_MESSAGE), { status: 500 });
  }
}
