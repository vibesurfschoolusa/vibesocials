import { NextRequest, NextResponse } from "next/server";
import { FACEBOOK_PAGE_SCOPES } from "@/lib/oauthScopes";

import { META_OAUTH_DIALOG_URL } from "@/lib/metaGraph";
import { createOAuthState } from "@/lib/oauthState";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "facebook_page_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  const { user, workspace } = contextOrRedirect;

  const clientId = process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.FACEBOOK_PAGE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    const url = new URL("/settings", request.url);
    url.searchParams.set("error", "facebook_page_not_configured");
    return NextResponse.redirect(url);
  }

  const encodedState = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  const authUrl = new URL(META_OAUTH_DIALOG_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", encodedState);
  authUrl.searchParams.set(
    "scope",
    // Only what the app uses (2026-11-09, for Meta App Review: unused
    // permissions are a common rejection reason). The app lists the user's
    // Pages and posts photos and videos to the chosen one; it never reads or
    // moderates comments.
    FACEBOOK_PAGE_SCOPES.join(","),
  );

  return NextResponse.redirect(authUrl.toString());
}
