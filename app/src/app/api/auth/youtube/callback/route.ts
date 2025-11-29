import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type: string;
  scope?: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const encodedState = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[YouTube OAuth] User denied access or error:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_denied`, request.url),
    );
  }

  if (!code || !encodedState) {
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_missing_params`, request.url),
    );
  }

  let userId: string;
  try {
    const stateData = JSON.parse(
      Buffer.from(encodedState, "base64url").toString(),
    );
    userId = stateData.userId;
  } catch (err) {
    console.error("[YouTube OAuth] Invalid state parameter", err);
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_invalid_state`, request.url),
    );
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[YouTube OAuth] Missing OAuth configuration");
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_config`, request.url),
    );
  }

  // Exchange code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    console.error(
      "[YouTube OAuth] Token exchange failed",
      tokenResponse.status,
      await tokenResponse.text(),
    );
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_token_failed`, request.url),
    );
  }

  const tokenJson = (await tokenResponse.json()) as GoogleTokenResponse;

  // Get channel info to use as accountIdentifier
  const channelResponse = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
      },
    },
  );

  if (!channelResponse.ok) {
    console.error(
      "[YouTube OAuth] Failed to fetch channel info",
      channelResponse.status,
    );
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_channel_fetch_failed`, request.url),
    );
  }

  const channelData = (await channelResponse.json()) as {
    items?: Array<{
      id?: string;
      snippet?: {
        title?: string;
      };
    }>;
  };

  const channel = channelData.items?.[0];
  if (!channel?.id) {
    console.error("[YouTube OAuth] No channel found for user");
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_no_channel`, request.url),
    );
  }

  const accountIdentifier = channel.snippet?.title || channel.id;
  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;

  // Upsert social connection
  try {
    await prisma.socialConnection.upsert({
      where: {
        userId_platform: {
          userId,
          platform: "youtube",
        },
      },
      create: {
        userId,
        platform: "youtube",
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes: tokenJson.scope ? tokenJson.scope.split(" ") : undefined,
        metadata: {
          channelId: channel.id,
          channelTitle: channel.snippet?.title,
        },
      },
      update: {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes: tokenJson.scope ? tokenJson.scope.split(" ") : undefined,
      },
    });

    console.log("[YouTube OAuth] Successfully connected channel:", accountIdentifier);

    return NextResponse.redirect(
      new URL("/settings?success=youtube_connected", request.url),
    );
  } catch (err) {
    console.error("[YouTube OAuth] Database error", err);
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_db_error`, request.url),
    );
  }
}
