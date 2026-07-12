import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { getTikTokCreatorInfo } from "@/server/platforms/tiktokClient";

/**
 * GET /api/tiktok/creator-info
 * Fetches TikTok creator info for the active workspace's connected TikTok
 * account (Team Workspaces — any member may read, same as connection
 * health generally). Required by TikTok Developer Guidelines before posting.
 */
export async function GET(req: NextRequest) {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Find TikTok connection for this workspace
    const tiktokConnection = await prisma.socialConnection.findFirst({
      where: {
        workspaceId: context.workspace.id,
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
  } catch (error: unknown) {
    console.error("[API] Failed to fetch TikTok creator info:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to fetch TikTok creator info" },
      { status: 500 }
    );
  }
}
