import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/reviews - Fetch Google Business Profile reviews
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get the user's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        userId: session.user.id,
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
      return NextResponse.json(
        { error: "Missing access token" },
        { status: 500 }
      );
    }

    // Get location name from metadata
    const metadata = (connection.metadata as any) ?? {};
    const locationName = metadata.locationName;

    if (!locationName) {
      return NextResponse.json(
        {
          error:
            "Location not configured. Please set it in the Connections page.",
        },
        { status: 400 }
      );
    }

    // Fetch reviews from Google Business Profile API
    const { fetchReviews } = await import("@/server/googleReviews");
    const reviews = await fetchReviews(accessToken, locationName);

    return NextResponse.json({ reviews });
  } catch (error: any) {
    console.error("[Reviews API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch reviews" },
      { status: 500 }
    );
  }
}
