import { NextResponse } from "next/server";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { prisma } from "@/lib/db";
import { GOOGLE_REFUSED_MESSAGE, isReviewResourceName, reviewsErrorBody } from "@/server/googleReviews";

export const dynamic = "force-dynamic";

const REPLY_FAILED_MESSAGE = "Couldn't post your reply. Try again in a minute.";

/**
 * POST /api/reviews/[reviewId]/reply - Reply to a Google Business Profile
 * review. Any member may reply (Team Workspaces — design §1: "Reply to
 * Google reviews (incl. AI draft)" is member-level).
 */
export async function POST(request: Request) {
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Pause (2026-11-10): a paused workspace cannot create or move work.
    const blocked = accessBlockResponse(context);
    if (blocked) return blocked;

    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
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

    // R1-security L5: the reply is sent to `<reviewName>/reply`, so only a
    // review's own resource name is sent on.
    if (!isReviewResourceName(reviewName)) {
      return NextResponse.json({ error: "Review not found." }, { status: 404 });
    }

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
      return NextResponse.json(
        { error: GOOGLE_REFUSED_MESSAGE, reconnect: true },
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
  } catch (error: unknown) {
    console.error("[Reviews API] Reply error:", error);
    return NextResponse.json(reviewsErrorBody(error, REPLY_FAILED_MESSAGE), { status: 500 });
  }
}
