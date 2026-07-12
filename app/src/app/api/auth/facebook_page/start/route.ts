import { NextRequest, NextResponse } from "next/server";

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
    return NextResponse.json(
      { error: "Facebook Page OAuth not configured" },
      { status: 500 },
    );
  }

  const encodedState = createOAuthState({ userId: user.id, workspaceId: workspace.id });

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
      // Required for reading engagement (comments, reactions, etc.)
      "pages_read_engagement",
      // Helpful for replying to comments and managing comment interactions
      "pages_manage_engagement",
    ].join(","),
  );

  return NextResponse.redirect(authUrl.toString());
}
