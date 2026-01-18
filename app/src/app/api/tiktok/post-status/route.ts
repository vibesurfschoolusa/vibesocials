import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

const TIKTOK_API_BASE = "https://open.tiktokapis.com";

/**
 * GET /api/tiktok/post-status?publishId=xxx&accessToken=xxx
 * Polls TikTok publish status API to check upload progress
 * Required by TikTok Developer Guidelines
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const publishId = searchParams.get("publishId");
  const accessToken = searchParams.get("accessToken");

  if (!publishId || !accessToken) {
    return NextResponse.json(
      { error: "publishId and accessToken are required" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publish_id: publishId,
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unable to read error body");
      console.error("[TikTok] post status fetch failed", {
        status: response.status,
        statusText: response.statusText,
        errorBody,
      });
      return NextResponse.json(
        { error: "Failed to fetch post status" },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // TikTok API returns status in data.status
    // Possible values: "processing_upload", "processing_download", "publish_complete", "failed"
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("[API] Failed to fetch TikTok post status:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch post status" },
      { status: 500 }
    );
  }
}
