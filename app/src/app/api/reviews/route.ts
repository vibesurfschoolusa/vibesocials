import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { refreshGoogleTokenEarly } from "@/server/platforms/googleTokens";
import { googleRefusedBody, reviewsErrorBody, type ReviewsReader } from "@/server/googleReviews";
import { signedOutResponse } from "@/lib/signedOutResponse";

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
      return signedOutResponse();
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

    // A connection Google has revoked reads "Reconnect" at once, as the link
    // route does, instead of after the stored token runs out.
    if (connection.needsReconnect) {
      return NextResponse.json(googleRefusedBody(role), { status: 500 });
    }

    // R23 client-journey L1: a token in its last 5 minutes is refreshed too,
    // so a long listing never runs past expiry (Google's 401 reads "Reconnect").
    // A failed early refresh of a still-valid token goes on with the stored one.
    const { refreshAccessToken } = await import("@/server/googleReviews");
    const accessToken = (await refreshGoogleTokenEarly(connection, refreshAccessToken)).accessToken;

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
