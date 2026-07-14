import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

/**
 * OAuth 1.0a signature generation
 * Uses HMAC-SHA1 to sign the request
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

const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  // X's OAuth 1.0a dance has no app-controlled `state` param — request-token
  // secret + userId + workspaceId are stored server-side in OAuthHandshake
  // (keyed by oauth_token), not in browser cookies.
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "x_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }
  const { user, workspace } = contextOrRedirect;

  const consumerKey = process.env.X_CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET;
  const callbackUrl = process.env.X_CALLBACK_URL;

  if (!consumerKey || !consumerSecret || !callbackUrl) {
    console.error("[X OAuth 1.0a] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=x_config_missing", process.env.NEXTAUTH_URL),
    );
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = Math.random().toString(36).substring(2);

    const oauthParams: Record<string, string> = {
      oauth_callback: callbackUrl,
      oauth_consumer_key: consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp,
      oauth_version: "1.0",
    };

    const requestTokenUrl = "https://api.twitter.com/oauth/request_token";
    const signature = generateOAuthSignature(
      "POST",
      requestTokenUrl,
      oauthParams,
      consumerSecret,
    );

    oauthParams.oauth_signature = signature;

    const authHeader =
      "OAuth " +
      Object.keys(oauthParams)
        .sort()
        .map((key) => `${key}="${encodeURIComponent(oauthParams[key])}"`)
        .join(", ");

    console.log("[X OAuth 1.0a] Requesting request token", {
      userId: user.id,
      callbackUrl,
    });

    const response = await fetch(requestTokenUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[X OAuth 1.0a] Request token failed", {
        status: response.status,
        error: errorText,
      });
      return NextResponse.redirect(
        new URL("/settings?error=x_request_token_failed", process.env.NEXTAUTH_URL),
      );
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);
    const oauthToken = params.get("oauth_token");
    const oauthTokenSecret = params.get("oauth_token_secret");

    if (!oauthToken || !oauthTokenSecret) {
      console.error("[X OAuth 1.0a] Invalid request token response");
      return NextResponse.redirect(
        new URL("/settings?error=x_invalid_token_response", process.env.NEXTAUTH_URL),
      );
    }

    const now = new Date();
    // Opportunistic cleanup of expired handshakes (~every start).
    if (Math.random() < 0.1) {
      void prisma.oAuthHandshake
        .deleteMany({ where: { expiresAt: { lt: now } } })
        .catch(() => {});
    }

    await prisma.oAuthHandshake.upsert({
      where: { token: oauthToken },
      create: {
        token: oauthToken,
        tokenSecret: oauthTokenSecret,
        userId: user.id,
        workspaceId: workspace.id,
        expiresAt: new Date(now.getTime() + HANDSHAKE_TTL_MS),
      },
      update: {
        tokenSecret: oauthTokenSecret,
        userId: user.id,
        workspaceId: workspace.id,
        expiresAt: new Date(now.getTime() + HANDSHAKE_TTL_MS),
      },
    });

    console.log("[X OAuth 1.0a] Request token received", {
      userId: user.id,
      oauthToken,
    });

    const authorizeUrl = new URL("https://api.twitter.com/oauth/authorize");
    authorizeUrl.searchParams.set("oauth_token", oauthToken);

    return NextResponse.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error("[X OAuth 1.0a] Unexpected error:", error);
    return NextResponse.redirect(
      new URL("/settings?error=x_unexpected_error", process.env.NEXTAUTH_URL),
    );
  }
}
