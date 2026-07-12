import { NextResponse } from "next/server";

import { createOAuthState } from "@/lib/oauthState";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "tiktok_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    const url = new URL(request.url);
    url.pathname = "/login";
    url.searchParams.set("from", "tiktok_connect");
    return NextResponse.redirect(url);
  }
  const { user, workspace } = contextOrRedirect;

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUriEnv = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !redirectUriEnv) {
    const url = new URL(request.url);
    url.pathname = "/settings";
    url.searchParams.set("error", "tiktok_not_configured");
    return NextResponse.redirect(url);
  }

  const state = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authUrl.searchParams.set("client_key", clientKey);
  authUrl.searchParams.set("redirect_uri", redirectUriEnv);
  authUrl.searchParams.set("response_type", "code");
  // video.publish scope required for Direct Post API with captions
  // Using FILE_UPLOAD with proper chunking (not PULL_FROM_URL which requires domain verification)
  authUrl.searchParams.set("scope", "user.info.basic,video.publish");
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
