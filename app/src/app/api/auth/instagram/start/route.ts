import { NextRequest, NextResponse } from "next/server";

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
    return NextResponse.json(
      { error: "Instagram OAuth not configured" },
      { status: 500 },
    );
  }

  const encodedState = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  // Instagram uses Facebook OAuth with specific scopes
  const authUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set(
    "scope",
    [
      "instagram_basic",
      "instagram_content_publish",
      // Needed for reading and moderating comments via the Instagram Graph API
      "instagram_manage_comments",
      "instagram_manage_messages",
      "pages_show_list",
      "pages_read_engagement",
      "business_management",
    ].join(","),
  );
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", encodedState);

  return NextResponse.redirect(authUrl.toString());
}
