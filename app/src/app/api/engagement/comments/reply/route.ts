import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type ReplyPlatform = "instagram" | "facebook_page";

interface ReplyRequestBody {
  commentId: string;
  platform: ReplyPlatform;
  message: string;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ReplyRequestBody;
  try {
    body = (await request.json()) as ReplyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const commentId = typeof body.commentId === "string" ? body.commentId.trim() : "";
  const platform = body.platform;
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!commentId) {
    return NextResponse.json({ error: "commentId is required" }, { status: 400 });
  }

  if (platform !== "instagram" && platform !== "facebook_page") {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "Reply message is required" }, { status: 400 });
  }

  const connection = await prisma.socialConnection.findFirst({
    where: {
      userId: user.id,
      platform: platform as any,
    },
  });

  if (!connection) {
    return NextResponse.json(
      { error: "No social connection found for this platform" },
      { status: 400 },
    );
  }

  const accessToken = connection.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "Missing access token for this platform" },
      { status: 500 },
    );
  }

  const baseUrl = "https://graph.facebook.com/v21.0";

  try {
    const endpointPath =
      platform === "instagram" ? `${commentId}/replies` : `${commentId}/comments`;

    const endpoint = new URL(`${baseUrl}/${endpointPath}`);

    const params = new URLSearchParams();
    params.set("message", message);
    params.set("access_token", accessToken);

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!response.ok) {
      const errorBody = await response
        .text()
        .catch(() => "Unable to read error body");
      console.error("[Engagement] Failed to post comment reply", {
        platform,
        commentId,
        status: response.status,
        errorBody,
      });

      const status =
        response.status === 400 || response.status === 403 ? 400 : 500;

      return NextResponse.json(
        {
          error: "Failed to post reply to comment",
          details:
            "The social platform API rejected the reply. Additional permissions such as instagram_manage_comments or pages_manage_engagement may be required.",
          raw: errorBody,
        },
        { status },
      );
    }

    const data = await response.json().catch(() => null);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Engagement] Unexpected error while posting comment reply", {
      platform,
      commentId,
      error,
    });

    return NextResponse.json(
      { error: "Unexpected error while posting reply" },
      { status: 500 },
    );
  }
}
