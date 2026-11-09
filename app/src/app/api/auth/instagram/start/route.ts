import { NextRequest, NextResponse } from "next/server";
import { INSTAGRAM_SCOPES } from "@/lib/oauthScopes";

import { META_OAUTH_DIALOG_URL } from "@/lib/metaGraph";
import { createOAuthState } from "@/lib/oauthState";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "instagram_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  const { user, workspace } = contextOrRedirect;

  const clientId = process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    const url = new URL("/settings", request.url);
    url.searchParams.set("error", "instagram_not_configured");
    return NextResponse.redirect(url);
  }

  const encodedState = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  // Instagram uses Facebook OAuth with specific scopes
  const authUrl = new URL(META_OAUTH_DIALOG_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set(
    "scope",
    // Only what the app uses (2026-11-09, for Meta App Review): no comment
    // or message permissions, and no business_management (Business Manager
    // APIs, which the app doesn't call).
    INSTAGRAM_SCOPES.join(","),
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", encodedState);

  return NextResponse.redirect(authUrl.toString());
}
