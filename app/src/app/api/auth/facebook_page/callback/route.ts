import { NextRequest, NextResponse } from "next/server";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { createPendingConnection } from "@/server/connections/pendingConnection";
import { saveFacebookPageConnection } from "@/server/connections/saveConnection";
import { Platform } from "@prisma/client";
import { withConnectLink } from "@/server/connectLink/callback";

async function handleCallback(request: NextRequest, link: ConnectLinkFlow | null) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[FacebookPage OAuth] Error from provider:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_missing_code_or_state", request.url),
    );
  }

  const stateCheck = verifyOAuthState(state, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return NextResponse.redirect(
      new URL("/settings?error=facebook_page_invalid_state", request.url),
    );
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user who started it. Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: Platform.facebook_page,
      stateUserId: userId,
      baseUrl: request.url,
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
    // owner of this workspace before writing a connection — ownership could
    // have changed between the redirect to Facebook and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_not_workspace_owner", request.url),
      );
    }

    const clientId = process.env.FACEBOOK_APP_ID;
    const clientSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.FACEBOOK_PAGE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[FacebookPage OAuth] Missing environment variables");
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_config_error", request.url),
      );
    }

    // 1. Exchange code for short-lived user access token
    const tokenUrl = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[FacebookPage OAuth] Token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_token_exchange_failed", request.url),
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
    };

    const shortLivedToken = tokenData.access_token;

    // 2. Exchange for long-lived user token (60 days)
    const longLivedUrl = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", clientId);
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    if (!longLivedResponse.ok) {
      const errorText = await longLivedResponse.text();
      console.error(
        "[FacebookPage OAuth] Long-lived token exchange failed:",
        errorText,
      );
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_long_lived_token_failed", request.url),
      );
    }

    const longLivedData = (await longLivedResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    const userAccessToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000; // 60 days default

    // 3. Get user's Facebook Pages
    const pagesUrl = new URL(`${META_GRAPH_BASE_URL}/me/accounts`);
    pagesUrl.searchParams.set("access_token", userAccessToken);
    pagesUrl.searchParams.set("fields", "id,name,access_token");

    const pagesResponse = await fetch(pagesUrl.toString());
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      console.error("[FacebookPage OAuth] Failed to fetch pages:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_failed_to_fetch_pages", request.url),
      );
    }

    const pagesData = (await pagesResponse.json()) as {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
      }>;
    };

    console.log("[FacebookPage OAuth] Pages fetched:", {
      count: pagesData.data?.length ?? 0,
      pages: pagesData.data?.map((page) => ({ id: page.id, name: page.name })) ?? [],
    });

    if (!pagesData.data || pagesData.data.length === 0) {
      console.error("[FacebookPage OAuth] No Facebook Pages found");
      return NextResponse.redirect(
        new URL("/settings?error=facebook_page_no_pages", request.url),
      );
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const pages = pagesData.data.map((page) => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
    }));

    // Several Pages (an agency managing its own and its clients'): connect
    // none of them yet — the user chooses one in Settings.
    if (pages.length > 1) {
      const pendingId = await createPendingConnection({
        workspaceId,
        userId,
        payload: { platform: "facebook_page", expiresAt: expiresAt.toISOString(), pages },
      });
      console.log("[FacebookPage OAuth] Several Pages found; waiting for the user to choose", {
        userId,
        count: pages.length,
      });
      return NextResponse.redirect(
        new URL(`/settings?choose=${encodeURIComponent(pendingId)}`, request.url),
      );
    }

    const [page] = pages;
    const pageId = page.id;
    const pageName = page.name;

    await saveFacebookPageConnection({ userId, workspaceId, page, expiresAt });

    console.log("[FacebookPage OAuth] Connection successful", {
      userId,
      pageId,
      pageName,
    });

    return NextResponse.redirect(
      new URL("/settings?success=facebook_page_connected", request.url),
    );
  } catch (error) {
    return oauthCallbackFailed({ platform: Platform.facebook_page, baseUrl: request.url, error });
  }
}

export const GET = withConnectLink("facebook_page", handleCallback);
