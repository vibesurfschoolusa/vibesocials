import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.FACEBOOK_PAGE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "Facebook Page OAuth not configured" },
      { status: 500 },
    );
  }

  const stateData = JSON.stringify({ userId: user.id });
  const encodedState = Buffer.from(stateData).toString("base64url");

  const authUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", encodedState);
  authUrl.searchParams.set(
    "scope",
    [
      "pages_show_list", // list pages user manages
      "pages_manage_posts", // publish to pages
    ].join(","),
  );

  return NextResponse.redirect(authUrl.toString());
}
