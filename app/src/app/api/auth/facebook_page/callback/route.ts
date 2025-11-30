import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[FacebookPage OAuth] Error from provider:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_missing_code_or_state", request.url),
    );
  }

  let userId: string;
  try {
    const stateData = JSON.parse(
      Buffer.from(state, "base64url").toString("utf-8"),
    );
    userId = stateData.userId;
  } catch {
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_invalid_state", request.url),
    );
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.FACEBOOK_PAGE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[FacebookPage OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_config_error", request.url),
    );
  }

  try {
    // 1. Exchange code for short-lived user access token
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[FacebookPage OAuth] Token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_token_exchange_failed", request.url),
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
    };

    const shortLivedToken = tokenData.access_token;

    // 2. Exchange for long-lived user token (60 days)
    const longLivedUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", clientId);
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    if (!longLivedResponse.ok) {
      const errorText = await longLivedResponse.text();
      console.error(
        "[FacebookPage OAuth] Long-lived token exchange failed:",
        errorText,
      );
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_long_lived_token_failed", request.url),
      );
    }

    const longLivedData = (await longLivedResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    const userAccessToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000; // 60 days default

    // 3. Get user's Facebook Pages
    const pagesUrl = new URL("https://graph.facebook.com/v21.0/me/accounts");
    pagesUrl.searchParams.set("access_token", userAccessToken);
    pagesUrl.searchParams.set("fields", "id,name,access_token");

    const pagesResponse = await fetch(pagesUrl.toString());
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      console.error("[FacebookPage OAuth] Failed to fetch pages:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_failed_to_fetch_pages", request.url),
      );
    }

    const pagesData = (await pagesResponse.json()) as {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
      }>;
    };

    console.log("[FacebookPage OAuth] Pages data:", JSON.stringify(pagesData, null, 2));

    if (!pagesData.data || pagesData.data.length === 0) {
      console.error("[FacebookPage OAuth] No Facebook Pages found");
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_no_pages", request.url),
      );
    }

    const desiredPageId = process.env.FACEBOOK_PAGE_ID;

    let targetPage = pagesData.data[0];
    if (desiredPageId) {
      const match = pagesData.data.find((p) => p.id === desiredPageId);
      if (match) {
        targetPage = match;
      }
    }

    const pageId = targetPage.id;
    const pageName = targetPage.name;
    const pageAccessToken = targetPage.access_token;

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await prisma.socialConnection.upsert({
      where: {
        userId_platform: {
          userId,
          platform: Platform.facebook_page,
        },
      },
      update: {
        accessToken: pageAccessToken,
        refreshToken: null,
        expiresAt,
        accountIdentifier: pageId,
        metadata: {
          pageName,
        },
      },
      create: {
        userId,
        platform: Platform.facebook_page,
        accessToken: pageAccessToken,
        refreshToken: null,
        expiresAt,
        accountIdentifier: pageId,
        metadata: {
          pageName,
        },
      },
    });

    console.log("[FacebookPage OAuth] Connection successful", {
      userId,
      pageId,
      pageName,
    });

    return NextResponse.redirect(
      new URL("/settings?success=facebook_page_connected", request.url),
    );
  } catch (err) {
    console.error("[FacebookPage OAuth] Unexpected error:", err);
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_unexpected_error", request.url),
    );
  }
}
