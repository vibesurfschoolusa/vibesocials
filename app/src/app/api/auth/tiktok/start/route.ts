import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createOAuthState } from "@/lib/oauthState";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    const url = new URL(request.url);
    url.pathname = "/login";
    url.searchParams.set("from", "tiktok_connect");
    return NextResponse.redirect(url);
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUriEnv = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !redirectUriEnv) {
    const url = new URL(request.url);
    url.pathname = "/settings";
    url.searchParams.set("error", "tiktok_not_configured");
    return NextResponse.redirect(url);
  }

  const state = createOAuthState(user.id);

  const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authUrl.searchParams.set("client_key", clientKey);
  authUrl.searchParams.set("redirect_uri", redirectUriEnv);
  authUrl.searchParams.set("response_type", "code");
  // video.publish scope required for Direct Post API (posting with captions)
  // video.upload scope is for Inbox API (draft uploads only)
  authUrl.searchParams.set("scope", "user.info.basic,video.publish");
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
