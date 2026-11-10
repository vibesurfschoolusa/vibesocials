import { NextResponse } from "next/server";

import { createOAuthState } from "@/lib/oauthState";
import { buildPinterestAuthorizeUrl, pinterestConfig } from "@/lib/pinterestApi";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export const runtime = "nodejs";

/**
 * GET /api/auth/pinterest/start: sends the workspace owner to Pinterest to
 * approve the app (scopes: lib/oauthScopes.ts PINTEREST_SCOPES).
 */
export async function GET(request: Request) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "pinterest_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    const url = new URL(request.url);
    url.pathname = "/login";
    url.searchParams.set("from", "pinterest_connect");
    return NextResponse.redirect(url);
  }
  const { user, workspace } = contextOrRedirect;

  const config = pinterestConfig();
  if (!config) {
    const url = new URL(request.url);
    url.pathname = "/settings";
    url.searchParams.set("error", "pinterest_not_configured");
    return NextResponse.redirect(url);
  }

  const state = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  return NextResponse.redirect(
    buildPinterestAuthorizeUrl({ appId: config.appId, redirectUri: config.redirectUri, state }),
  );
}
