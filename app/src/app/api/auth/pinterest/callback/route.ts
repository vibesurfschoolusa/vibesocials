import { NextRequest, NextResponse } from "next/server";
import { refusedSaveSettingsUrl } from "@/lib/differentAccount";
import { Platform } from "@prisma/client";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { PINTEREST_SCOPES } from "@/lib/oauthScopes";
import { verifyOAuthState } from "@/lib/oauthState";
import {
  PINTEREST_TOKEN_URL,
  pinterestBasicAuthHeader,
  pinterestConfig,
  readPinterestErrorCode,
} from "@/lib/pinterestApi";
import { isWorkspaceOwner } from "@/lib/workspace";
import { createPendingConnection } from "@/server/connections/pendingConnection";
import { fetchPinterestAccount, listPinterestBoards } from "@/server/connections/pinterestAccount";
import { savePinterestConnection, type PinterestToken } from "@/server/connections/saveConnection";
import { withConnectLink } from "@/server/connectLink/callback";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";

export const runtime = "nodejs";

/** `expires_in` when the token answer has none: Pinterest's documented 30 days. */
const PINTEREST_DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface PinterestTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * GET /api/auth/pinterest/callback: Pinterest returns here with `code` + `state`.
 *
 * Exchanges the code (POST /oauth/token, HTTP Basic auth), reads the account's
 * username and its boards, and connects:
 *  - one board: straight away, posting to it;
 *  - several: none yet; they wait in a PendingConnection and Settings asks which
 *    board (`/settings?choose=<id>`), like a Facebook user with several Pages;
 *  - none: `pinterest_no_boards` (a Pin has to go on a board).
 */
async function handleCallback(request: NextRequest, link: ConnectLinkFlow | null) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (errorParam) {
    // Pinterest's own code (e.g. access_denied); the helper names the platform
    // and passes on only a short, plain code.
    return oauthErrorRedirect("pinterest", errorParam, url.origin);
  }

  if (!code || !state) {
    return oauthErrorRedirect("pinterest", "missing_params", url.origin);
  }

  const stateCheck = verifyOAuthState(state, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return oauthErrorRedirect("pinterest", "invalid_state", url.origin);
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed in
    // as the user who started it. Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: Platform.pinterest,
      stateUserId: userId,
      baseUrl: url.origin,
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Ownership could have changed between the redirect to Pinterest and this
    // return trip: re-verify before writing a connection.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return oauthErrorRedirect("pinterest", "not_workspace_owner", url.origin);
    }

    const config = pinterestConfig();
    if (!config) {
      return oauthErrorRedirect("pinterest", "not_configured", url.origin);
    }

    const tokenResponse = await fetchWithTimeout(PINTEREST_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: pinterestBasicAuthHeader(config.appId, config.appSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text().catch(() => "");
      console.error("[Pinterest OAuth] Token exchange failed", {
        status: tokenResponse.status,
        errorCode: readPinterestErrorCode(errorBody),
      });
      return oauthErrorRedirect("pinterest", "token_exchange_failed", url.origin);
    }

    const tokenJson = (await tokenResponse.json()) as PinterestTokenResponse;
    if (typeof tokenJson.access_token !== "string" || tokenJson.access_token === "") {
      console.error("[Pinterest OAuth] Token answer has no access_token");
      return oauthErrorRedirect("pinterest", "token_exchange_failed", url.origin);
    }

    const expiresInSeconds =
      typeof tokenJson.expires_in === "number" &&
      Number.isFinite(tokenJson.expires_in) &&
      tokenJson.expires_in > 0
        ? tokenJson.expires_in
        : PINTEREST_DEFAULT_TOKEN_TTL_SECONDS;
    const grantedScopes =
      typeof tokenJson.scope === "string"
        ? tokenJson.scope
            .split(/[\s,]+/)
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
        : [];

    const token: PinterestToken = {
      accessToken: tokenJson.access_token,
      refreshToken:
        typeof tokenJson.refresh_token === "string" && tokenJson.refresh_token !== ""
          ? tokenJson.refresh_token
          : null,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      scopes: grantedScopes.length > 0 ? grantedScopes : [...PINTEREST_SCOPES],
    };

    const [account, boards] = await Promise.all([
      fetchPinterestAccount(token.accessToken),
      listPinterestBoards(token.accessToken),
    ]);

    if (!account || !boards) {
      return oauthErrorRedirect("pinterest", "account_unavailable", url.origin);
    }

    if (boards.length === 0) {
      return oauthErrorRedirect("pinterest", "no_boards", url.origin);
    }

    if (boards.length > 1) {
      const pendingId = await createPendingConnection({
        workspaceId,
        userId,
        payload: {
          platform: "pinterest",
          token: {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt.toISOString(),
            scopes: token.scopes,
          },
          account,
          boards,
        },
      });
      settingsUrl.searchParams.set("choose", pendingId);
      return NextResponse.redirect(settingsUrl);
    }

    const saved = await savePinterestConnection({ userId, workspaceId, token, account, board: boards[0] });
    if (!saved.ok) {
      // R6 review low 1: a different account (or, for Business Profile, one
      // that couldn't be checked) than the one connected; nothing changed.
      return NextResponse.redirect(refusedSaveSettingsUrl(url.origin, Platform.pinterest, saved));
    }

    settingsUrl.searchParams.set("success", "pinterest_connected");
    return NextResponse.redirect(settingsUrl);
  } catch (error) {
    return oauthCallbackFailed({ platform: Platform.pinterest, baseUrl: url.origin, error });
  }
}

export const GET = withConnectLink("pinterest", handleCallback);
