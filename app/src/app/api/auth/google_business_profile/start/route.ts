import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createOAuthState } from "@/lib/oauthState";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    const url = new URL(request.url);
    url.pathname = "/login";
    url.searchParams.set("from", "google_business_profile_connect");
    return NextResponse.redirect(url);
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const redirectUriEnv = process.env.GOOGLE_GBP_REDIRECT_URI;

  if (!clientId || !redirectUriEnv) {
    const url = new URL(request.url);
    url.pathname = "/settings";
    url.searchParams.set("error", "google_business_profile_not_configured");
    return NextResponse.redirect(url);
  }

  const state = createOAuthState(user.id);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriEnv);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/business.manage");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
