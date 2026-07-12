import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[Instagram OAuth] Error from provider:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings?error=instagram_missing_code_or_state", request.url),
    );
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return NextResponse.redirect(
      new URL("/settings?error=instagram_invalid_state", request.url),
    );
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
  // owner of this workspace before writing a connection — ownership could
  // have changed between the redirect to Facebook and this return trip.
  if (!(await isWorkspaceOwner(userId, workspaceId))) {
    return NextResponse.redirect(
      new URL("/settings?error=instagram_not_workspace_owner", request.url),
    );
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[Instagram OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=instagram_config_error", request.url),
    );
  }

  try {
    // 1. Exchange code for short-lived access token
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[Instagram OAuth] Token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_token_exchange_failed", request.url),
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
    };

    const shortLivedToken = tokenData.access_token;

    // 2. Exchange for long-lived token
    const longLivedUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", clientId);
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    if (!longLivedResponse.ok) {
      const errorText = await longLivedResponse.text();
      console.error("[Instagram OAuth] Long-lived token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_long_lived_token_failed", request.url),
      );
    }

    const longLivedData = (await longLivedResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    const accessToken = longLivedData.access_token;
    // Facebook long-lived tokens last 60 days (5184000 seconds)
    // Default to 60 days if expires_in is not provided
    const expiresIn = longLivedData.expires_in || 5184000; // 60 days in seconds

    // 3. Get user's Facebook Pages
    const pagesUrl = new URL("https://graph.facebook.com/v21.0/me/accounts");
    pagesUrl.searchParams.set("access_token", accessToken);
    pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account");

    const pagesResponse = await fetch(pagesUrl.toString());
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      console.error("[Instagram OAuth] Failed to fetch pages:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_failed_to_fetch_pages", request.url),
      );
    }

    const pagesData = (await pagesResponse.json()) as {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: {
          id: string;
        };
      }>;
    };

    console.log("[Instagram OAuth] Pages fetched:", {
      count: pagesData.data?.length ?? 0,
      pages: pagesData.data?.map((page) => ({ id: page.id, name: page.name })) ?? [],
    });

    // Find the first page with an Instagram Business Account
    const pageWithInstagram = pagesData.data.find(
      (page) => page.instagram_business_account,
    );

    if (!pageWithInstagram || !pageWithInstagram.instagram_business_account) {
      console.error("[Instagram OAuth] No Instagram Business Account found");
      return NextResponse.redirect(
        new URL("/settings?error=instagram_no_instagram_account", request.url),
      );
    }

    const igAccountId = pageWithInstagram.instagram_business_account.id;
    const pageAccessToken = pageWithInstagram.access_token;

    // 4. Get Instagram account details
    const igUrl = new URL(`https://graph.facebook.com/v21.0/${igAccountId}`);
    igUrl.searchParams.set("fields", "username,profile_picture_url");
    igUrl.searchParams.set("access_token", pageAccessToken);

    const igResponse = await fetch(igUrl.toString());
    if (!igResponse.ok) {
      const errorText = await igResponse.text();
      console.error("[Instagram OAuth] Failed to fetch IG account:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_failed_to_fetch_ig_account", request.url),
      );
    }

    const igData = (await igResponse.json()) as {
      username: string;
      profile_picture_url?: string;
    };

    // 5. Store or update the connection
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: "instagram" as Platform,
        },
      },
      update: {
        accessToken: pageAccessToken,
        refreshToken: null,
        expiresAt,
        accountIdentifier: igAccountId,
        metadata: {
          username: igData.username,
          profilePicture: igData.profile_picture_url || null,
          pageId: pageWithInstagram.id,
        },
        // Roadmap Phase 4: successful reconnect clears the flag set by a
        // prior COR-5 reconnect-required failure (see
        // server/platforms/connectionHealth.ts).
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
      create: {
        userId,
        workspaceId,
        platform: "instagram" as Platform,
        accessToken: pageAccessToken,
        refreshToken: null,
        expiresAt,
        accountIdentifier: igAccountId,
        metadata: {
          username: igData.username,
          profilePicture: igData.profile_picture_url || null,
          pageId: pageWithInstagram.id,
        },
        // Roadmap Phase 4: a fresh connect always starts in a healthy state.
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });

    console.log("[Instagram OAuth] Connection successful", {
      userId,
      username: igData.username,
      igAccountId,
    });

    return NextResponse.redirect(
      new URL("/settings?success=instagram_connected", request.url),
    );
  } catch (error) {
    console.error("[Instagram OAuth] Unexpected error:", error);
    return NextResponse.redirect(
      new URL("/settings?error=instagram_unexpected_error", request.url),
    );
  }
}
