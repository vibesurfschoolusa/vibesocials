import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform } from "@prisma/client";

export const runtime = "nodejs";

interface TikTokTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  open_id: string;
  scope?: string;
  token_type: string;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (errorParam) {
    settingsUrl.searchParams.set("error", errorParam);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set("error", "tiktok_missing_code_or_state");
    return NextResponse.redirect(settingsUrl);
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    settingsUrl.searchParams.set("error", "tiktok_invalid_state");
    return NextResponse.redirect(settingsUrl);
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
  // owner of this workspace before writing a connection — ownership could
  // have changed between the redirect to TikTok and this return trip.
  if (!(await isWorkspaceOwner(userId, workspaceId))) {
    settingsUrl.searchParams.set("error", "tiktok_not_workspace_owner");
    return NextResponse.redirect(settingsUrl);
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !clientSecret || !redirectUri) {
    settingsUrl.searchParams.set("error", "tiktok_not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      console.error("[TikTok OAuth] Token exchange failed", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
      });
      settingsUrl.searchParams.set("error", "tiktok_token_exchange_failed");
      return NextResponse.redirect(settingsUrl);
    }

    const tokenJson = (await tokenResponse.json()) as TikTokTokenResponse;

    console.log("[TikTok OAuth] Token response received:", {
      hasAccessToken: !!tokenJson.access_token,
      hasRefreshToken: !!tokenJson.refresh_token,
      hasOpenId: !!tokenJson.open_id,
      expiresIn: tokenJson.expires_in,
      scope: tokenJson.scope,
      tokenType: tokenJson.token_type,
    });

    if (!tokenJson.access_token) {
      const errorDetails = tokenJson as unknown as {
        error?: string;
        error_description?: string;
        log_id?: string;
      };
      console.error("[TikTok OAuth] Missing access_token in response", {
        error: errorDetails.error,
        errorDescription: errorDetails.error_description,
        logId: errorDetails.log_id,
      });
      settingsUrl.searchParams.set("error", "tiktok_missing_access_token");
      return NextResponse.redirect(settingsUrl);
    }

    const now = Date.now();
    const expiresAt = tokenJson.expires_in
      ? new Date(now + tokenJson.expires_in * 1000)
      : null;

    const accountIdentifier = tokenJson.open_id;

    const rawScope = tokenJson.scope ?? "";
    const scopes = rawScope
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: Platform.tiktok,
        },
      },
      create: {
        userId,
        workspaceId,
        platform: Platform.tiktok,
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes,
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
        scopes,
        // Roadmap Phase 4: successful reconnect clears the flag set by a
        // prior refresh failure (see server/platforms/connectionHealth.ts).
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });

    settingsUrl.searchParams.set("success", "tiktok_connected");
    return NextResponse.redirect(settingsUrl);
  } catch (error) {
    console.error("[TikTok OAuth] Unexpected error", { error });
    settingsUrl.searchParams.set("error", "tiktok_unexpected_error");
    return NextResponse.redirect(settingsUrl);
  }
}
