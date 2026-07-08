import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createOAuthState } from "@/lib/oauthState";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const redirectUriEnv = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !redirectUriEnv) {
    return NextResponse.json(
      { error: "YouTube OAuth not configured" },
      { status: 500 },
    );
  }

  // Sign the state with the canonical HMAC helper so the callback can trust userId.
  const encodedState = createOAuthState(user.id);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriEnv);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", encodedState);

  return NextResponse.redirect(authUrl.toString());
}
