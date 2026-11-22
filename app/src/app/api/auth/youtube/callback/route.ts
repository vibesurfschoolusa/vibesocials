import { NextRequest, NextResponse } from "next/server";

import { saveSocialConnection } from "@/server/connections/saveConnection";
import { refusedSaveSettingsUrl } from "@/lib/differentAccount";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { verifyOAuthState } from "@/lib/oauthState";
import { YOUTUBE_SCOPES, YOUTUBE_UPLOAD_SCOPE } from "@/lib/oauthScopes";
import { isWorkspaceOwner } from "@/lib/workspace";
import { withConnectLink } from "@/server/connectLink/callback";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";
import { CONNECT_CALL_TIMEOUT_MS, fetchWithinLimit } from "@/lib/fetchWithTimeout";

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
    // Google's own code: access_denied is a cancel, any other a failure (R44 pages-a L7).
    return oauthErrorRedirect("youtube", error, request.url);
  }

  if (!code || !encodedState) {
    return oauthErrorRedirect("youtube", "oauth_missing_params", request.url);
  }

  const stateCheck = verifyOAuthState(encodedState, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    console.error("[YouTube OAuth] Invalid state parameter");
    return oauthErrorRedirect("youtube", "oauth_invalid_state", request.url);
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
      return oauthErrorRedirect("youtube", "not_workspace_owner", request.url);
    }

    const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[YouTube OAuth] Missing OAuth configuration");
      return oauthErrorRedirect("youtube", "oauth_config", request.url);
    }

    // Exchange code for tokens
    const tokenResponse = await fetchWithinLimit("https://oauth2.googleapis.com/token", {
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
    }, CONNECT_CALL_TIMEOUT_MS);

    if (!tokenResponse.ok) {
      console.error(
        "[YouTube OAuth] Token exchange failed",
        tokenResponse.status,
        await tokenResponse.text(),
      );
      return oauthErrorRedirect("youtube", "oauth_token_failed", request.url);
    }

    const tokenJson = (await tokenResponse.json()) as GoogleTokenResponse;

    // R27 platform-clients L3: "Manage your YouTube videos" unticked on
    // Google's screen grants no upload, and every post would fail. Nothing is
    // saved; the page says to allow it. A token answer without `scope` (Google
    // always sends it) is taken as before.
    const granted = tokenJson.scope?.split(" ");
    if (granted && !granted.includes(YOUTUBE_UPLOAD_SCOPE)) {
      console.warn("[YouTube OAuth] Connected without the upload permission; nothing saved");
      return oauthErrorRedirect("youtube", "upload_not_allowed", request.url);
    }
    // R28 platform-clients L3: "View your YouTube account" (youtube.readonly)
    // unticked: the channel call below would answer 403 and read as a
    // generic failure, and the same choice would fail the same way again.
    if (granted && !YOUTUBE_SCOPES.every((scope) => granted.includes(scope))) {
      console.warn("[YouTube OAuth] Connected without the view permission; nothing saved");
      return oauthErrorRedirect("youtube", "readonly_not_allowed", request.url);
    }

    // Get channel info to use as accountIdentifier
    const channelResponse = await fetchWithinLimit(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
        },
      },
      CONNECT_CALL_TIMEOUT_MS,
    );

    if (!channelResponse.ok) {
      console.error(
        "[YouTube OAuth] Failed to fetch channel info",
        channelResponse.status,
      );
      return oauthErrorRedirect("youtube", "channel_fetch_failed", request.url);
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
      return oauthErrorRedirect("youtube", "no_channel", request.url);
    }

    const accountIdentifier = channel.snippet?.title || channel.id;
    const expiresAt = tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000)
      : null;

    // Upsert social connection (R6 review low 1: only for the same channel)
    const saved = await saveSocialConnection({
      userId,
      workspaceId,
      platform: "youtube",
      signedInName: channel.snippet?.title || channel.id,
      create: {
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
    if (!saved.ok) {
      // R6 review low 1: a different account (or, for Business Profile, one
      // that couldn't be checked) than the one connected; nothing changed.
      return NextResponse.redirect(refusedSaveSettingsUrl(request.url, "youtube", saved));
    }

    // R67 pages-a-2 L1: never the channel's title, often the person's own name.
    console.log("[YouTube OAuth] Successfully connected the channel");

    return NextResponse.redirect(
      new URL("/settings?success=youtube_connected", request.url),
    );
  } catch (error) {
    // Network failure, unparseable provider JSON or a DB error: never a 500.
    return oauthCallbackFailed({ platform: "youtube", baseUrl: request.url, error });
  }
}

export const GET = withConnectLink("youtube", handleCallback);
