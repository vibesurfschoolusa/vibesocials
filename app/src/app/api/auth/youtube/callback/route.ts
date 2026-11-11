import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { withConnectLink } from "@/server/connectLink/callback";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type: string;
  scope?: string;
}

async function handleCallback(request: NextRequest, link: ConnectLinkFlow | null) {
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

  const stateCheck = verifyOAuthState(encodedState, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    console.error("[YouTube OAuth] Invalid state parameter");
    return NextResponse.redirect(
      new URL(`/settings?error=youtube_oauth_invalid_state`, request.url),
    );
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user who started it. Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: "youtube",
      stateUserId: userId,
      baseUrl: request.url,
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
    // owner of this workspace before writing a connection — ownership could
    // have changed between the redirect to Google and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return NextResponse.redirect(
        new URL(`/settings?error=youtube_not_workspace_owner`, request.url),
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
    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: "youtube",
        },
      },
      create: {
        userId,
        workspaceId,
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
        // Roadmap Phase 4: a fresh connect always starts in a healthy state.
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
      update: {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes: tokenJson.scope ? tokenJson.scope.split(" ") : undefined,
        // Roadmap Phase 4: successful reconnect clears the flag set by a
        // prior refresh failure (see server/platforms/connectionHealth.ts).
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });

    console.log("[YouTube OAuth] Successfully connected channel:", accountIdentifier);

    return NextResponse.redirect(
      new URL("/settings?success=youtube_connected", request.url),
    );
  } catch (error) {
    // Network failure, unparseable provider JSON or a DB error: never a 500.
    return oauthCallbackFailed({ platform: "youtube", baseUrl: request.url, error });
  }
}

export const GET = withConnectLink("youtube", handleCallback);
