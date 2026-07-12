import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import { cookies } from "next/headers";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform } from "@prisma/client";

/**
 * OAuth 1.0a signature generation
 */
function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string = ""
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

  const signature = createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  return signature;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const oauthToken = searchParams.get("oauth_token");
  const oauthVerifier = searchParams.get("oauth_verifier");
  const denied = searchParams.get("denied");

  if (denied) {
    console.error("[X OAuth 1.0a] Authorization denied");
    return NextResponse.redirect(
      new URL(`/settings?error=x_auth_denied`, process.env.NEXTAUTH_URL!)
    );
  }

  if (!oauthToken || !oauthVerifier) {
    console.error("[X OAuth 1.0a] Missing oauth_token or oauth_verifier");
    return NextResponse.redirect(
      new URL("/settings?error=x_missing_params", process.env.NEXTAUTH_URL!)
    );
  }

  // Get stored data from cookies. Team Workspaces (Task 6, design §5): X's
  // OAuth 1.0a dance has no app-controlled `state` param, so workspaceId
  // rides the same httpOnly-cookie bridge as userId (set at /start)
  // rather than createOAuthState/verifyOAuthState.
  const cookieStore = await cookies();
  const oauthTokenSecret = cookieStore.get("x_oauth_token_secret")?.value;
  const userId = cookieStore.get("x_user_id")?.value;
  const workspaceId = cookieStore.get("x_workspace_id")?.value;

  if (!oauthTokenSecret || !userId || !workspaceId) {
    console.error("[X OAuth 1.0a] Missing stored token secret, user ID, or workspace ID");
    return NextResponse.redirect(
      new URL("/settings?error=x_session_expired", process.env.NEXTAUTH_URL!)
    );
  }

  // Re-verify the caller is STILL an owner of this workspace before writing
  // a connection — ownership could have changed between the redirect to X
  // and this return trip.
  if (!(await isWorkspaceOwner(userId, workspaceId))) {
    return NextResponse.redirect(
      new URL("/settings?error=x_not_workspace_owner", process.env.NEXTAUTH_URL!)
    );
  }

  const consumerKey = process.env.X_CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    console.error("[X OAuth 1.0a] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=x_config_missing", process.env.NEXTAUTH_URL!)
    );
  }

  try {
    // Step 3: Exchange request token + verifier for access token
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
    const signature = generateOAuthSignature("POST", accessTokenUrl, oauthParams, consumerSecret, oauthTokenSecret);

    oauthParams.oauth_signature = signature;

    const authHeader =
      "OAuth " +
      Object.keys(oauthParams)
        .sort()
        .map((key) => `${key}="${encodeURIComponent(oauthParams[key])}"`)
        .join(", ");

    const response = await fetch(accessTokenUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[X OAuth 1.0a] Access token exchange failed", {
        status: response.status,
        error: errorText,
      });
      return NextResponse.redirect(
        new URL("/settings?error=x_token_exchange_failed", process.env.NEXTAUTH_URL!)
      );
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);
    const accessToken = params.get("oauth_token");
    const accessTokenSecret = params.get("oauth_token_secret");
    const screenName = params.get("screen_name");
    const userIdFromX = params.get("user_id");

    if (!accessToken || !accessTokenSecret) {
      console.error("[X OAuth 1.0a] Invalid access token response");
      return NextResponse.redirect(
        new URL("/settings?error=x_invalid_token_response", process.env.NEXTAUTH_URL!)
      );
    }

    console.log("[X OAuth 1.0a] Access token received", {
      screenName,
      userIdFromX,
    });

    // Store or update social connection. Team Workspaces (Task 6): keyed on
    // the workspaceId_platform compound unique (same as every other
    // platform), stamping both workspaceId and userId (connector
    // attribution) — replaces the old find-by-userId-then-branch, which
    // predated workspaces and never matched the other 6 platforms' upsert
    // shape.
    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: Platform.x,
        },
      },
      update: {
        accountIdentifier: userIdFromX || screenName || "",
        accessToken: accessToken,
        refreshToken: accessTokenSecret, // Store token secret as refreshToken
        expiresAt: null, // OAuth 1.0a tokens don't expire
        scopes: "read write", // OAuth 1.0a doesn't have explicit scopes
        metadata: {
          username: screenName,
          user_id: userIdFromX,
        },
        // Roadmap Phase 4: successful reconnect clears the flag set by a
        // prior refresh failure (see server/platforms/connectionHealth.ts).
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
      create: {
        userId,
        workspaceId,
        platform: Platform.x,
        accountIdentifier: userIdFromX || screenName || "",
        accessToken: accessToken,
        refreshToken: accessTokenSecret, // Store token secret as refreshToken
        expiresAt: null, // OAuth 1.0a tokens don't expire
        scopes: "read write",
        metadata: {
          username: screenName,
          user_id: userIdFromX,
        },
        // Roadmap Phase 4: a fresh connect always starts in a healthy state.
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });
    console.log("[X OAuth 1.0a] Connection saved", { userId, workspaceId });

    // Clear cookies
    const redirectResponse = NextResponse.redirect(
      new URL("/settings?success=x_connected", process.env.NEXTAUTH_URL!)
    );
    redirectResponse.cookies.delete("x_oauth_token_secret");
    redirectResponse.cookies.delete("x_user_id");
    redirectResponse.cookies.delete("x_workspace_id");

    return redirectResponse;
  } catch (err) {
    console.error("[X OAuth 1.0a] Unexpected error:", err);
    return NextResponse.redirect(
      new URL("/settings?error=x_unexpected_error", process.env.NEXTAUTH_URL!)
    );
  }
}
