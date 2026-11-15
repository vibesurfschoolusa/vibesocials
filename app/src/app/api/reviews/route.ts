import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { googleRefusedBody, reviewsErrorBody, type ReviewsReader } from "@/server/googleReviews";

export const dynamic = "force-dynamic";

const REVIEWS_FAILED_MESSAGE = "Couldn't load your Google reviews. Try again in a minute.";

/**
 * GET /api/reviews?location=... - Fetch Google Business Profile reviews for a
 * specific location. Any member may read (Team Workspaces — design §1:
 * "Reply to Google reviews" is member-level, and reading is a strict subset).
 * F7: every page Google has, up to REVIEWS_SHOWN_MAX (`truncated` when more);
 * errors are plain sentences (reviewsErrorBody).
 */
export async function GET(request: Request) {
  // R12 L1: who reads the answer. Until the context is read, nobody is offered a reconnect.
  let role: ReviewsReader = "member";
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    role = context.role;

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

    // Check if token needs refresh
    let accessToken = connection.accessToken;
    if (connection.expiresAt && connection.expiresAt < new Date()) {
      console.log("[Reviews] Access token expired, refreshing...");
      const { refreshAccessToken } = await import("@/server/googleReviews");
      const updated = await refreshAccessToken(connection);
      accessToken = updated.accessToken;
    }

    if (!accessToken) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // Get location name from query param or metadata
    const metadata = (connection.metadata as { locationName?: string } | null) ?? {};
    const locationName = locationParam || metadata.locationName;

    if (!locationName) {
      return NextResponse.json(
        {
          error:
            "Please select a location to view reviews.",
        },
        { status: 400 }
      );
    }

    // Fetch reviews from Google Business Profile API
    const { fetchAllReviews } = await import("@/server/googleReviews");
    const { reviews, truncated } = await fetchAllReviews(accessToken, locationName);

    return NextResponse.json({ reviews, truncated });
  } catch (error: unknown) {
    console.error("[Reviews API] Error:", error);
    return NextResponse.json(reviewsErrorBody(error, REVIEWS_FAILED_MESSAGE, role), { status: 500 });
  }
}
