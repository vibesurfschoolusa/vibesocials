import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

import { getCurrentUser } from "@/lib/auth";

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

  const state = randomBytes(16).toString("hex");

  // Store state in session or database to verify on callback
  // For simplicity, we're including the userId in the state
  const stateData = JSON.stringify({ state, userId: user.id });
  const encodedState = Buffer.from(stateData).toString("base64url");

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
