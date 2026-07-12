import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
import { resolveWorkspaceForUser } from "@/lib/workspace";
import { Platform } from "@prisma/client";

export const runtime = "nodejs";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type: string;
  scope?: string;
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
    settingsUrl.searchParams.set("error", "missing_code_or_state");
    return NextResponse.redirect(settingsUrl);
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId) {
    settingsUrl.searchParams.set("error", "invalid_state");
    return NextResponse.redirect(settingsUrl);
  }

  const userId = stateCheck.userId;

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_GBP_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    settingsUrl.searchParams.set("error", "google_business_profile_not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  try {
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
      console.error("[GBP OAuth] Token exchange failed", {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
      });
      settingsUrl.searchParams.set("error", "token_exchange_failed");
      return NextResponse.redirect(settingsUrl);
    }

    const tokenJson = (await tokenResponse.json()) as TokenResponse;

    const now = Date.now();
    const expiresAt = tokenJson.expires_in
      ? new Date(now + tokenJson.expires_in * 1000)
      : null;

    let accountIdentifier = "google_business_profile";

    if (tokenJson.id_token) {
      try {
        const [, payloadSegment] = tokenJson.id_token.split(".");
        const payloadJson = Buffer.from(payloadSegment, "base64url").toString("utf8");
        const payload = JSON.parse(payloadJson) as { sub?: string; email?: string };
        if (payload.sub) {
          accountIdentifier = payload.sub;
        } else if (payload.email) {
          accountIdentifier = payload.email;
        }
      } catch {
        // If ID token parsing fails, fall back to default accountIdentifier.
      }
    }

    // WORKSPACE-BRIDGE: personal-workspace interim — replaced by getWorkspaceContext/job.workspaceId in Tasks 4-6.
    const workspaceId = await resolveWorkspaceForUser(userId);

    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: Platform.google_business_profile,
        },
      },
      create: {
        userId,
        // WORKSPACE-BRIDGE: personal-workspace interim — replaced by getWorkspaceContext/job.workspaceId in Tasks 4-6.
        workspaceId,
        platform: Platform.google_business_profile,
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes: tokenJson.scope ? tokenJson.scope.split(" ") : undefined,
        metadata: {
          locationName: null,
        },
        // Roadmap Phase 4: a fresh/successful connect always starts (and a
        // reconnect always resets to) a healthy state.
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

    settingsUrl.searchParams.set("success", "google_business_profile_connected");
    return NextResponse.redirect(settingsUrl);
  } catch (error) {
    console.error("[GBP OAuth] Unexpected error", { error });
    settingsUrl.searchParams.set("error", "unexpected_error");
    return NextResponse.redirect(settingsUrl);
  }
}
