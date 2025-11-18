import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
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

interface RouteContext {
  params: Record<string, string>;
}

export async function GET(request: Request, _context: RouteContext) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const connectionsUrl = new URL("/connections", url.origin);

  if (errorParam) {
    connectionsUrl.searchParams.set("error", errorParam);
    return NextResponse.redirect(connectionsUrl);
  }

  if (!code || !state) {
    connectionsUrl.searchParams.set("error", "tiktok_missing_code_or_state");
    return NextResponse.redirect(connectionsUrl);
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId) {
    connectionsUrl.searchParams.set("error", "tiktok_invalid_state");
    return NextResponse.redirect(connectionsUrl);
  }

  const userId = stateCheck.userId;

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !clientSecret || !redirectUri) {
    connectionsUrl.searchParams.set("error", "tiktok_not_configured");
    return NextResponse.redirect(connectionsUrl);
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
      connectionsUrl.searchParams.set("error", "tiktok_token_exchange_failed");
      return NextResponse.redirect(connectionsUrl);
    }

    const tokenJson = (await tokenResponse.json()) as TikTokTokenResponse;

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
        userId_platform: {
          userId,
          platform: Platform.tiktok,
        },
      },
      create: {
        userId,
        platform: Platform.tiktok,
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes,
      },
      update: {
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes,
      },
    });

    connectionsUrl.searchParams.set("connected", "tiktok");
    return NextResponse.redirect(connectionsUrl);
  } catch (error) {
    console.error("[TikTok OAuth] Unexpected error", { error });
    connectionsUrl.searchParams.set("error", "tiktok_unexpected_error");
    return NextResponse.redirect(connectionsUrl);
  }
}
