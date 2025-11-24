import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

import { getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "Instagram OAuth not configured" },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString("hex");
  const stateData = JSON.stringify({ state, userId: user.id });
  const encodedState = Buffer.from(stateData).toString("base64url");

  // Instagram uses Facebook OAuth with specific scopes
  const authUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", encodedState);

  return NextResponse.redirect(authUrl.toString());
}
