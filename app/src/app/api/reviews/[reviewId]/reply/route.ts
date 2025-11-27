import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/reviews/[reviewId]/reply - Reply to a Google Business Profile review
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { reviewId } = await params;
    const body = await request.json();
    const { comment, reviewName } = body;

    if (!comment || typeof comment !== "string" || comment.trim().length === 0) {
      return NextResponse.json(
        { error: "Reply comment is required" },
        { status: 400 }
      );
    }

    if (!reviewName || typeof reviewName !== "string") {
      return NextResponse.json(
        { error: "Review name is required" },
        { status: 400 }
      );
    }

    // Get the user's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        userId: user.id,
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

    // Post reply to Google Business Profile API using full review name
    const { replyToReview } = await import("@/server/googleReviews");
    const result = await replyToReview(
      accessToken,
      reviewName,
      comment.trim()
    );

    return NextResponse.json({
      success: true,
      reply: result,
    });
  } catch (error: any) {
    console.error("[Reviews API] Reply error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to post reply" },
      { status: 500 }
    );
  }
}
