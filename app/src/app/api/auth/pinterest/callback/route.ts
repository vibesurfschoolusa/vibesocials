import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
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
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (errorParam) {
    // Pinterest's own code (e.g. access_denied), prefixed so lib/oauthResult.ts
    // names the platform; only a short, plain code is passed on.
    const safe = /^[a-z_]{1,40}$/.test(errorParam) ? errorParam : "auth_failed";
    settingsUrl.searchParams.set("error", `pinterest_${safe}`);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set("error", "pinterest_missing_params");
    return NextResponse.redirect(settingsUrl);
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    settingsUrl.searchParams.set("error", "pinterest_invalid_state");
    return NextResponse.redirect(settingsUrl);
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
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Ownership could have changed between the redirect to Pinterest and this
    // return trip: re-verify before writing a connection.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      settingsUrl.searchParams.set("error", "pinterest_not_workspace_owner");
      return NextResponse.redirect(settingsUrl);
    }

    const config = pinterestConfig();
    if (!config) {
      settingsUrl.searchParams.set("error", "pinterest_not_configured");
      return NextResponse.redirect(settingsUrl);
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
      settingsUrl.searchParams.set("error", "pinterest_token_exchange_failed");
      return NextResponse.redirect(settingsUrl);
    }

    const tokenJson = (await tokenResponse.json()) as PinterestTokenResponse;
    if (typeof tokenJson.access_token !== "string" || tokenJson.access_token === "") {
      console.error("[Pinterest OAuth] Token answer has no access_token");
      settingsUrl.searchParams.set("error", "pinterest_token_exchange_failed");
      return NextResponse.redirect(settingsUrl);
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
      settingsUrl.searchParams.set("error", "pinterest_account_unavailable");
      return NextResponse.redirect(settingsUrl);
    }

    if (boards.length === 0) {
      settingsUrl.searchParams.set("error", "pinterest_no_boards");
      return NextResponse.redirect(settingsUrl);
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

    await savePinterestConnection({ userId, workspaceId, token, account, board: boards[0] });

    settingsUrl.searchParams.set("success", "pinterest_connected");
    return NextResponse.redirect(settingsUrl);
  } catch (error) {
    return oauthCallbackFailed({ platform: Platform.pinterest, baseUrl: url.origin, error });
  }
}
