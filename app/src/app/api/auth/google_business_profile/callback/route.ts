import { NextRequest, NextResponse } from "next/server";

import { saveSocialConnection } from "@/server/connections/saveConnection";
import { LOCATION_CLEARED_PARAM, refusedSaveSettingsUrl } from "@/lib/differentAccount";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform } from "@prisma/client";
import { withConnectLink } from "@/server/connectLink/callback";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";

export const runtime = "nodejs";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type: string;
  scope?: string;
}

async function handleCallback(request: NextRequest, link: ConnectLinkFlow | null) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (errorParam) {
    return oauthErrorRedirect("google_business_profile", errorParam, url.origin);
  }

  if (!code || !state) {
    return oauthErrorRedirect("google_business_profile", "missing_code_or_state", url.origin);
  }

  const stateCheck = verifyOAuthState(state, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return oauthErrorRedirect("google_business_profile", "invalid_state", url.origin);
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user who started it. Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: Platform.google_business_profile,
      stateUserId: userId,
      baseUrl: url.origin,
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
    // owner of this workspace before writing a connection — ownership could
    // have changed between the redirect to Google and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return oauthErrorRedirect("google_business_profile", "not_workspace_owner", url.origin);
    }

    const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_GBP_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return oauthErrorRedirect("google_business_profile", "not_configured", url.origin);
    }

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
      return oauthErrorRedirect("google_business_profile", "token_exchange_failed", url.origin);
    }

    const tokenJson = (await tokenResponse.json()) as TokenResponse;

    const now = Date.now();
    const expiresAt = tokenJson.expires_in
      ? new Date(now + tokenJson.expires_in * 1000)
      : null;

    // Only business.manage is asked, so the token names no Google account:
    // a reconnect is checked against the chosen location instead
    // (saveConnection.ts gbpVerdict, R6 second review 1).
    const accountIdentifier = "google_business_profile";

    const saved = await saveSocialConnection({
      userId,
      workspaceId,
      platform: Platform.google_business_profile,
      signedInName: null,
      create: {
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
    if (!saved.ok) {
      // R6 review low 1: a different account (or, for Business Profile, one
      // that couldn't be checked) than the one connected; nothing changed.
      return NextResponse.redirect(refusedSaveSettingsUrl(url.origin, Platform.google_business_profile, saved));
    }

    settingsUrl.searchParams.set("success", "google_business_profile_connected");
    if (saved.locationCleared !== undefined) {
      // R6 third review: this Google account can't use the chosen location, so
      // it was cleared; Settings asks for one (the chooser). A flag only: no
      // name in the address (R7-new-customer L2).
      settingsUrl.searchParams.set(LOCATION_CLEARED_PARAM, "1");
    }
    return NextResponse.redirect(settingsUrl);
  } catch (error) {
    return oauthCallbackFailed({
      platform: Platform.google_business_profile,
      baseUrl: url.origin,
      error,
    });
  }
}

export const GET = withConnectLink("google_business_profile", handleCallback);
