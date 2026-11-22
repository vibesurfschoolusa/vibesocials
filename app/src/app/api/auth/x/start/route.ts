import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";
import { oauthErrorRedirect } from "@/lib/oauthErrorRedirect";
import { CONNECT_CALL_TIMEOUT_MS, fetchWithinLimit } from "@/lib/fetchWithTimeout";
import { signedOutConnectRedirect } from "@/lib/signedOutConnect";
import { checkRateLimit } from "@/lib/rateLimit";

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
/**
 * R61 security-billing-2 L1: each start makes one request-token call to X on
 * the app's shared key and writes one handshake, so starts are limited per
 * person, as the client-link start limits the same call.
 */
const X_STARTS_PER_HOUR = 30;
/** How long past its expiry a client link's handshake is kept for the callback. */
const LINK_HANDSHAKE_KEPT_MS = 24 * 60 * 60 * 1000;

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
    return signedOutConnectRedirect(process.env.NEXTAUTH_URL);
  }
  const { user, workspace } = contextOrRedirect;

  const consumerKey = process.env.X_CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET;
  const callbackUrl = process.env.X_CALLBACK_URL;

  if (!consumerKey || !consumerSecret || !callbackUrl) {
    console.error("[X OAuth 1.0a] Missing environment variables");
    return oauthErrorRedirect("x", "config_missing", process.env.NEXTAUTH_URL);
  }

  // Fails closed: a store that can't answer must not open unlimited calls to X.
  const limit = await checkRateLimit({
    userId: user.id,
    route: "auth/x/start",
    limit: X_STARTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (limit.unavailable) return oauthErrorRedirect("x", "limit_unchecked", process.env.NEXTAUTH_URL);
  if (!limit.allowed) return oauthErrorRedirect("x", "too_many_tries", process.env.NEXTAUTH_URL);

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

    // R36 platform-clients L1: bounded headers and body; a stall throws into the catch below.
    const response = await fetchWithinLimit(requestTokenUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
      },
    }, CONNECT_CALL_TIMEOUT_MS);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[X OAuth 1.0a] Request token failed", {
        status: response.status,
        error: errorText,
      });
      return oauthErrorRedirect("x", "request_token_failed", process.env.NEXTAUTH_URL);
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);
    const oauthToken = params.get("oauth_token");
    const oauthTokenSecret = params.get("oauth_token_secret");

    if (!oauthToken || !oauthTokenSecret) {
      console.error("[X OAuth 1.0a] Invalid request token response");
      return oauthErrorRedirect("x", "invalid_token_response", process.env.NEXTAUTH_URL);
    }

    const now = new Date();
    // Opportunistic cleanup of expired handshakes (about one start in ten).
    // R56 client-journey L1: a client link's row is kept a day past its
    // expiry, so a client whose X sign-in took longer than 10 minutes still
    // gets the callback's /c reopen page rather than /settings or /login.
    if (Math.random() < 0.1) {
      void prisma.oAuthHandshake
        .deleteMany({
          where: {
            OR: [
              { connectLinkId: null, expiresAt: { lt: now } },
              { connectLinkId: { not: null }, expiresAt: { lt: new Date(now.getTime() - LINK_HANDSHAKE_KEPT_MS) } },
            ],
          },
        })
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

    // R67: console.log skips the logger's redaction, so never the token itself.
    console.log("[X OAuth 1.0a] Request token received", {
      userId: user.id,
      hasOauthToken: true,
    });

    const authorizeUrl = new URL("https://api.twitter.com/oauth/authorize");
    authorizeUrl.searchParams.set("oauth_token", oauthToken);

    return NextResponse.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error("[X OAuth 1.0a] Unexpected error:", error);
    return oauthErrorRedirect("x", "unexpected_error", process.env.NEXTAUTH_URL);
  }
}
