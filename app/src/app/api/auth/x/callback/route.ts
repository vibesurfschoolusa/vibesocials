import { NextResponse } from "next/server";
import { saveSocialConnection } from "@/server/connections/saveConnection";
import { refusedSaveSettingsUrl } from "@/lib/differentAccount";
import { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import type { ConnectLinkFlow } from "@/lib/connectLink";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform } from "@prisma/client";
import { withConnectLink } from "@/server/connectLink/callback";
import { appOrigin } from "@/server/connectLink/origin";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";
import { CONNECT_CALL_TIMEOUT_MS, fetchWithinLimit } from "@/lib/fetchWithTimeout";

/**
 * OAuth 1.0a signature generation
 */
function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string = "",
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");

  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join("&");

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  return createHmac("sha1", signingKey).update(signatureBase).digest("base64");
}

/**
 * R55 client-journey L1: X finds a link flow only by its vs_connect cookie
 * (server/connectLink/callback.ts), which is gone after 15 minutes, in another
 * browser or in X's in-app one. A link's handshake without a link flow gets
 * the "open the link you were sent again" page the other platforms give
 * there, not /settings (for a signed-out client, the sign-in page).
 */
function linkHandshakeWithoutFlow(
  handshake: { connectLinkId?: string | null } | null,
  link: ConnectLinkFlow | null,
  request: Request,
): NextResponse | null {
  return handshake?.connectLinkId && !link ? NextResponse.redirect(new URL("/c", appOrigin(request))) : null;
}

async function handleCallback(request: Request, link: ConnectLinkFlow | null) {
  const { searchParams } = new URL(request.url);
  const oauthToken = searchParams.get("oauth_token");
  const oauthVerifier = searchParams.get("oauth_verifier");
  const denied = searchParams.get("denied");

  if (denied) {
    console.error("[X OAuth 1.0a] Authorization denied");
    // A failed lookup answers as before: the owner's /settings.
    const deniedHandshake = link
      ? null
      : await prisma.oAuthHandshake.findUnique({ where: { token: denied } }).catch(() => null);
    return linkHandshakeWithoutFlow(deniedHandshake, link, request) ?? oauthErrorRedirect("x", "auth_denied", process.env.NEXTAUTH_URL!);
  }

  if (!oauthToken || !oauthVerifier) {
    console.error("[X OAuth 1.0a] Missing oauth_token or oauth_verifier");
    return oauthErrorRedirect("x", "missing_params", process.env.NEXTAUTH_URL!);
  }

  try {
    // Load handshake from server-side store (not cookies).
    const handshake = await prisma.oAuthHandshake.findUnique({
      where: { token: oauthToken },
    });

    if (!handshake || handshake.expiresAt <= new Date()) {
      if (handshake) {
        await prisma.oAuthHandshake.delete({ where: { token: oauthToken } }).catch(() => {});
      }
      console.error("[X OAuth 1.0a] Missing or expired handshake");
      return linkHandshakeWithoutFlow(handshake, link, request) ?? oauthErrorRedirect("x", "session_expired", process.env.NEXTAUTH_URL!);
    }

    // Client connect link: a handshake row belongs to a link flow exactly when
    // withConnectLink found that flow's cookie, so an ordinary flow never
    // finishes a link's handshake and a link flow never finishes an owner's.
    if (
      (handshake.connectLinkId ?? null) !== (link?.id ?? null) ||
      (handshake.connectLinkNonce ?? null) !== (link?.nonce ?? null)
    ) {
      return linkHandshakeWithoutFlow(handshake, link, request) ?? oauthErrorRedirect("x", "session_expired", process.env.NEXTAUTH_URL!);
    }

    const { tokenSecret: oauthTokenSecret, userId, workspaceId } = handshake;

    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user who started it (the handshake's user). Before the
    // verifier exchange; writes nothing (the handshake is left to expire).
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: Platform.x,
      stateUserId: userId,
      baseUrl: process.env.NEXTAUTH_URL!,
      link,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Re-verify the caller is STILL an owner of this workspace before writing
    // a connection — ownership could have changed between the redirect to X
    // and this return trip.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      await prisma.oAuthHandshake.delete({ where: { token: oauthToken } }).catch(() => {});
      return oauthErrorRedirect("x", "not_workspace_owner", process.env.NEXTAUTH_URL!);
    }

    const consumerKey = process.env.X_CONSUMER_KEY;
    const consumerSecret = process.env.X_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      console.error("[X OAuth 1.0a] Missing environment variables");
      return oauthErrorRedirect("x", "config_missing", process.env.NEXTAUTH_URL!);
    }

    console.log("[X OAuth 1.0a] Exchanging for access token", { userId });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = Math.random().toString(36).substring(2);

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp,
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier,
      oauth_version: "1.0",
    };

    const accessTokenUrl = "https://api.twitter.com/oauth/access_token";
    const signature = generateOAuthSignature(
      "POST",
      accessTokenUrl,
      oauthParams,
      consumerSecret,
      oauthTokenSecret,
    );

    oauthParams.oauth_signature = signature;

    const authHeader =
      "OAuth " +
      Object.keys(oauthParams)
        .sort()
        .map((key) => `${key}="${encodeURIComponent(oauthParams[key])}"`)
        .join(", ");

    const response = await fetchWithinLimit(accessTokenUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
      },
    }, CONNECT_CALL_TIMEOUT_MS);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[X OAuth 1.0a] Access token exchange failed", {
        status: response.status,
        error: errorText,
      });
      return oauthErrorRedirect("x", "token_exchange_failed", process.env.NEXTAUTH_URL!);
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);
    const accessToken = params.get("oauth_token");
    const accessTokenSecret = params.get("oauth_token_secret");
    const screenName = params.get("screen_name");
    const userIdFromX = params.get("user_id");

    if (!accessToken || !accessTokenSecret) {
      console.error("[X OAuth 1.0a] Invalid access token response");
      return oauthErrorRedirect("x", "invalid_token_response", process.env.NEXTAUTH_URL!);
    }

    console.log("[X OAuth 1.0a] Access token received", {
      screenName,
      userIdFromX,
    });

    const saved = await saveSocialConnection({
      userId,
      workspaceId,
      platform: Platform.x,
      signedInName: screenName ? `@${screenName}` : null,
      update: {
        accountIdentifier: userIdFromX || screenName || "",
        accessToken: accessToken,
        refreshToken: accessTokenSecret,
        expiresAt: null,
        scopes: "read write",
        metadata: {
          username: screenName,
          user_id: userIdFromX,
        },
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
      create: {
        accountIdentifier: userIdFromX || screenName || "",
        accessToken: accessToken,
        refreshToken: accessTokenSecret,
        expiresAt: null,
        scopes: "read write",
        metadata: {
          username: screenName,
          user_id: userIdFromX,
        },
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });
    if (!saved.ok) {
      // R6 review low 1: a different account than the one connected; nothing
      // changed. The one-time handshake is used up all the same.
      await prisma.oAuthHandshake.delete({ where: { token: oauthToken } }).catch(() => {});
      return NextResponse.redirect(refusedSaveSettingsUrl(process.env.NEXTAUTH_URL!, Platform.x, saved));
    }
    console.log("[X OAuth 1.0a] Connection saved", { userId, workspaceId });

    // One-time handshake — delete after successful exchange.
    await prisma.oAuthHandshake.delete({ where: { token: oauthToken } }).catch(() => {});

    return NextResponse.redirect(
      new URL("/settings?success=x_connected", process.env.NEXTAUTH_URL!),
    );
  } catch (error) {
    return oauthCallbackFailed({ platform: Platform.x, baseUrl: process.env.NEXTAUTH_URL!, error });
  }
}

export const GET = withConnectLink("x", handleCallback);
