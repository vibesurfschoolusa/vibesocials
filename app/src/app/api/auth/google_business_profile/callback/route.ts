import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
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
    connectionsUrl.searchParams.set("error", "missing_code_or_state");
    return NextResponse.redirect(connectionsUrl);
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId) {
    connectionsUrl.searchParams.set("error", "invalid_state");
    return NextResponse.redirect(connectionsUrl);
  }

  const userId = stateCheck.userId;

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_GBP_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    connectionsUrl.searchParams.set("error", "google_business_profile_not_configured");
    return NextResponse.redirect(connectionsUrl);
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
      connectionsUrl.searchParams.set("error", "token_exchange_failed");
      return NextResponse.redirect(connectionsUrl);
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

    await prisma.socialConnection.upsert({
      where: {
        userId_platform: {
          userId,
          platform: Platform.google_business_profile,
        },
      },
      create: {
        userId,
        platform: Platform.google_business_profile,
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token ?? null,
        expiresAt,
        accountIdentifier,
        scopes: tokenJson.scope ? tokenJson.scope.split(" ") : undefined,
        metadata: {
          locationName: null,
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

    connectionsUrl.searchParams.set("connected", "google_business_profile");
    return NextResponse.redirect(connectionsUrl);
  } catch (error) {
    console.error("[GBP OAuth] Unexpected error", { error });
    connectionsUrl.searchParams.set("error", "unexpected_error");
    return NextResponse.redirect(connectionsUrl);
  }
}
