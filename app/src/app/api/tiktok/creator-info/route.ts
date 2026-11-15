import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import {
  TIKTOK_CREATOR_CANNOT_POST,
  ensureFreshTikTokToken,
  getTikTokCreatorInfo,
} from "@/server/platforms/tiktokClient";

/**
 * GET /api/tiktok/creator-info
 * Fetches TikTok creator info for the active workspace's connected TikTok
 * account (Team Workspaces — any member may read, same as connection
 * health generally). TikTok's guideline 1 requires the latest creator info
 * whenever the "post to TikTok" screen renders.
 *
 * TikTok access tokens last 24 hours, so an expired one is refreshed first
 * (as the publisher does); otherwise the panel failed to load once a day.
 * A "can't post right now" answer (HTTP 200 + error code, guideline 1b) is a
 * 409 with TikTok's reason, so the composer stops and prompts the user.
 */
export async function GET() {
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

    const connection = await ensureFreshTikTokToken(tiktokConnection);
    if (!connection.accessToken) {
      return NextResponse.json(
        { error: "TikTok access token missing" },
        { status: 400 }
      );
    }

    const creatorInfo = await getTikTokCreatorInfo(connection.accessToken);

    return NextResponse.json(creatorInfo);
  } catch (error: unknown) {
    const coded = error as Error & { code?: string };
    if (coded.code === TIKTOK_CREATOR_CANNOT_POST) {
      return NextResponse.json({ error: coded.message, code: coded.code }, { status: 409 });
    }
    if (coded.code === "TIKTOK_RECONNECT_REQUIRED") {
      return NextResponse.json(
        { error: "Reconnect TikTok in Settings to keep posting.", code: coded.code },
        { status: 401 },
      );
    }
    console.error("[API] Failed to fetch TikTok creator info:", error);
    return NextResponse.json(
      { error: coded.message || "Failed to fetch TikTok creator info" },
      { status: 500 }
    );
  }
}
