import { NextRequest, NextResponse } from "next/server";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { createPendingConnection } from "@/server/connections/pendingConnection";
import {
  fetchInstagramAccountDetails,
  saveInstagramConnection,
} from "@/server/connections/saveConnection";
import { Platform } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[Instagram OAuth] Error from provider:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings?error=instagram_missing_code_or_state", request.url),
    );
  }

  const stateCheck = verifyOAuthState(state);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return NextResponse.redirect(
      new URL("/settings?error=instagram_invalid_state", request.url),
    );
  }

  const userId = stateCheck.userId;
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user who started it. Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: Platform.instagram,
      stateUserId: userId,
      baseUrl: request.url,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
    // owner of this workspace before writing a connection — ownership could
    // have changed between the redirect to Facebook and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return NextResponse.redirect(
        new URL("/settings?error=instagram_not_workspace_owner", request.url),
      );
    }

    const clientId = process.env.FACEBOOK_APP_ID;
    const clientSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[Instagram OAuth] Missing environment variables");
      return NextResponse.redirect(
        new URL("/settings?error=instagram_config_error", request.url),
      );
    }

    // 1. Exchange code for short-lived access token
    const tokenUrl = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[Instagram OAuth] Token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_token_exchange_failed", request.url),
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
    };

    const shortLivedToken = tokenData.access_token;

    // 2. Exchange for long-lived token
    const longLivedUrl = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", clientId);
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    if (!longLivedResponse.ok) {
      const errorText = await longLivedResponse.text();
      console.error("[Instagram OAuth] Long-lived token exchange failed:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_long_lived_token_failed", request.url),
      );
    }

    const longLivedData = (await longLivedResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    const accessToken = longLivedData.access_token;
    // Facebook long-lived tokens last 60 days (5184000 seconds)
    // Default to 60 days if expires_in is not provided
    const expiresIn = longLivedData.expires_in || 5184000; // 60 days in seconds

    // 3. Get user's Facebook Pages
    const pagesUrl = new URL(`${META_GRAPH_BASE_URL}/me/accounts`);
    pagesUrl.searchParams.set("access_token", accessToken);
    pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account");

    const pagesResponse = await fetch(pagesUrl.toString());
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      console.error("[Instagram OAuth] Failed to fetch pages:", errorText);
      return NextResponse.redirect(
        new URL("/settings?error=instagram_failed_to_fetch_pages", request.url),
      );
    }

    const pagesData = (await pagesResponse.json()) as {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: {
          id: string;
        };
      }>;
    };

    console.log("[Instagram OAuth] Pages fetched:", {
      count: pagesData.data?.length ?? 0,
      pages: pagesData.data?.map((page) => ({ id: page.id, name: page.name })) ?? [],
    });

    // The pages with an Instagram Business Account linked
    const pagesWithInstagram = pagesData.data.flatMap((page) =>
      page.instagram_business_account
        ? [{ page, igAccountId: page.instagram_business_account.id }]
        : [],
    );

    if (pagesWithInstagram.length === 0) {
      console.error("[Instagram OAuth] No Instagram Business Account found");
      return NextResponse.redirect(
        new URL("/settings?error=instagram_no_instagram_account", request.url),
      );
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Several Instagram accounts (an agency managing its own and its
    // clients'): connect none of them yet — the user chooses one in Settings.
    // Each account's username is read for the list; one Graph error leaves
    // that row showing just its Page name.
    if (pagesWithInstagram.length > 1) {
      const accounts = await Promise.all(
        pagesWithInstagram.map(async ({ page, igAccountId }) => {
          const details = await fetchInstagramAccountDetails(
            igAccountId,
            page.access_token,
          ).catch(() => null);
          return {
            igAccountId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: page.access_token,
            username: details?.username ?? null,
          };
        }),
      );
      const pendingId = await createPendingConnection({
        workspaceId,
        userId,
        payload: { platform: "instagram", expiresAt: expiresAt.toISOString(), accounts },
      });
      console.log("[Instagram OAuth] Several Instagram accounts found; waiting for the user to choose", {
        userId,
        count: accounts.length,
      });
      return NextResponse.redirect(
        new URL(`/settings?choose=${encodeURIComponent(pendingId)}`, request.url),
      );
    }

    const [{ page: pageWithInstagram, igAccountId }] = pagesWithInstagram;
    const pageAccessToken = pageWithInstagram.access_token;

    // 4. Get Instagram account details
    const details = await fetchInstagramAccountDetails(igAccountId, pageAccessToken);
    if (!details) {
      return NextResponse.redirect(
        new URL("/settings?error=instagram_failed_to_fetch_ig_account", request.url),
      );
    }

    // 5. Store or update the connection
    await saveInstagramConnection({
      userId,
      workspaceId,
      igAccountId,
      pageId: pageWithInstagram.id,
      pageAccessToken,
      details,
      expiresAt,
    });

    console.log("[Instagram OAuth] Connection successful", {
      userId,
      username: details.username,
      igAccountId,
    });

    return NextResponse.redirect(
      new URL("/settings?success=instagram_connected", request.url),
    );
  } catch (error) {
    return oauthCallbackFailed({ platform: Platform.instagram, baseUrl: request.url, error });
  }
}
