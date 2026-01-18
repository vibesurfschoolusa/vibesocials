import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTikTokCreatorInfo } from "@/server/platforms/tiktokClient";

/**
 * GET /api/tiktok/creator-info
 * Fetches TikTok creator info for the authenticated user's connected TikTok account
 * Required by TikTok Developer Guidelines before posting
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Find TikTok connection for this user
    const tiktokConnection = await prisma.socialConnection.findFirst({
      where: {
        userId: user.id,
        platform: "tiktok",
      },
    });

    if (!tiktokConnection) {
      return NextResponse.json(
        { error: "No TikTok account connected" },
        { status: 404 }
      );
    }

    if (!tiktokConnection.accessToken) {
      return NextResponse.json(
        { error: "TikTok access token missing" },
        { status: 400 }
      );
    }

    // Fetch creator info from TikTok API
    const creatorInfo = await getTikTokCreatorInfo(tiktokConnection.accessToken);

    return NextResponse.json(creatorInfo);
  } catch (error: any) {
    console.error("[API] Failed to fetch TikTok creator info:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch TikTok creator info" },
      { status: 500 }
    );
  }
}
