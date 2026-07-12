import { NextRequest, NextResponse } from "next/server";

import { createOAuthState } from "@/lib/oauthState";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "youtube_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  const { user, workspace } = contextOrRedirect;

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const redirectUriEnv = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !redirectUriEnv) {
    return NextResponse.json(
      { error: "YouTube OAuth not configured" },
      { status: 500 },
    );
  }

  // Sign the state with the canonical HMAC helper so the callback can trust
  // both userId and workspaceId.
  const encodedState = createOAuthState({ userId: user.id, workspaceId: workspace.id });

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
