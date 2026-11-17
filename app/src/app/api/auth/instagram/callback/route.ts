import { NextRequest, NextResponse } from "next/server";
import { refusedSaveSettingsUrl } from "@/lib/differentAccount";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { listMetaPages } from "@/server/connections/metaPages";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { createPendingConnection } from "@/server/connections/pendingConnection";
import {
  fetchInstagramAccountDetails,
  INSTAGRAM_DETAILS_BUDGET_MS,
  saveInstagramConnection,
} from "@/server/connections/saveConnection";
import { Platform } from "@prisma/client";
import { withConnectLink } from "@/server/connectLink/callback";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";
import { CONNECT_CALL_TIMEOUT_MS, fetchWithinLimit } from "@/lib/fetchWithTimeout";

/**
 * R32 lead follow-up: a connect can list up to 1,000 Pages now, so their
 * Instagram details are read this many at a time, not all at once.
 */
const INSTAGRAM_DETAILS_IN_FLIGHT = 5;

/** `fn` over `items` with at most `limit` running at once; results in the items' order. */
async function mapFewAtATime<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function handleCallback(request: NextRequest, link: ConnectLinkFlow | null) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[Instagram OAuth] Error from provider:", error);
    return oauthErrorRedirect("instagram", error, request.url);
  }

  if (!code || !state) {
    return oauthErrorRedirect("instagram", "missing_code_or_state", request.url);
  }

  const stateCheck = verifyOAuthState(state, link);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    return oauthErrorRedirect("instagram", "invalid_state", request.url);
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
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Team Workspaces (Task 6, design §5): re-verify the caller is STILL an
    // owner of this workspace before writing a connection — ownership could
    // have changed between the redirect to Facebook and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return oauthErrorRedirect("instagram", "not_workspace_owner", request.url);
    }

    const clientId = process.env.FACEBOOK_APP_ID;
    const clientSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[Instagram OAuth] Missing environment variables");
      return oauthErrorRedirect("instagram", "config_error", request.url);
    }

    // 1. Exchange code for short-lived access token
    const tokenUrl = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetchWithinLimit(tokenUrl.toString(), undefined, CONNECT_CALL_TIMEOUT_MS);
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[Instagram OAuth] Token exchange failed:", errorText);
      return oauthErrorRedirect("instagram", "token_exchange_failed", request.url);
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

    const longLivedResponse = await fetchWithinLimit(longLivedUrl.toString(), undefined, CONNECT_CALL_TIMEOUT_MS);
    if (!longLivedResponse.ok) {
      const errorText = await longLivedResponse.text();
      console.error("[Instagram OAuth] Long-lived token exchange failed:", errorText);
      return oauthErrorRedirect("instagram", "long_lived_token_failed", request.url);
    }

    const longLivedData = (await longLivedResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    const accessToken = longLivedData.access_token;
    // Facebook long-lived tokens last 60 days (5184000 seconds)
    // Default to 60 days if expires_in is not provided
    const expiresIn = longLivedData.expires_in || 5184000; // 60 days in seconds

    // 3. Get user's Facebook Pages: every page of the list (R32 platform-clients M1)
    const pagesRead = await listMetaPages<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }>(accessToken, "id,name,access_token,instagram_business_account", "[Instagram OAuth]");
    if (!pagesRead.ok) {
      return oauthErrorRedirect("instagram", "failed_to_fetch_pages", request.url);
    }

    console.log("[Instagram OAuth] Pages fetched:", {
      count: pagesRead.pages.length,
      cut: pagesRead.cut,
      pages: pagesRead.pages.map((page) => ({ id: page.id, name: page.name })),
    });

    // The pages with an Instagram Business Account linked
    const pagesWithInstagram = pagesRead.pages.flatMap((page) =>
      page.instagram_business_account
        ? [{ page, igAccountId: page.instagram_business_account.id }]
        : [],
    );

    if (pagesWithInstagram.length === 0) {
      console.error("[Instagram OAuth] No Instagram Business Account found");
      return oauthErrorRedirect("instagram", "no_instagram_account", request.url);
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Several Instagram accounts (an agency managing its own and its
    // clients'): connect none of them yet — the user chooses one in Settings.
    // Each account's username is read for the list; one Graph error leaves
    // that row showing just its Page name.
    if (pagesWithInstagram.length > 1) {
      // R36 review low 3: one budget for all the reads, so many accounts on a
      // slow Graph stay inside the function's time limit. Once it is spent no
      // read starts and those in flight end; an unread account is listed by
      // its Page name, and the choice reads its details when it is chosen.
      const budget = AbortSignal.timeout(INSTAGRAM_DETAILS_BUDGET_MS);
      const accounts = await mapFewAtATime(
        pagesWithInstagram,
        INSTAGRAM_DETAILS_IN_FLIGHT,
        async ({ page, igAccountId }) => {
          const details = budget.aborted
            ? null
            : await fetchInstagramAccountDetails(igAccountId, page.access_token, budget);
          return {
            igAccountId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: page.access_token,
            username: details?.username ?? null,
          };
        },
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
      return oauthErrorRedirect("instagram", "failed_to_fetch_ig_account", request.url);
    }

    // 5. Store or update the connection
    const saved = await saveInstagramConnection({
      userId,
      workspaceId,
      igAccountId,
      pageId: pageWithInstagram.id,
      pageAccessToken,
      details,
      expiresAt,
    });
    if (!saved.ok) {
      // R6 review low 1: a different account (or, for Business Profile, one
      // that couldn't be checked) than the one connected; nothing changed.
      return NextResponse.redirect(refusedSaveSettingsUrl(request.url, Platform.instagram, saved));
    }

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

export const GET = withConnectLink("instagram", handleCallback);
