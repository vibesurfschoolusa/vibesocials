import { NextResponse } from "next/server";

import { createOAuthState } from "@/lib/oauthState";
import { buildPinterestAuthorizeUrl, pinterestConfig } from "@/lib/pinterestApi";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";
import { signedOutConnectRedirect } from "@/lib/signedOutConnect";

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
    return signedOutConnectRedirect(request.url);
  }
  const { user, workspace } = contextOrRedirect;

  const config = pinterestConfig();
  if (!config) {
    return oauthErrorRedirect("pinterest", "not_configured", request.url);
  }

  const state = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  return NextResponse.redirect(
    buildPinterestAuthorizeUrl({ appId: config.appId, redirectUri: config.redirectUri, state }),
  );
}
