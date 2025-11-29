import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { getCurrentUser } from "@/lib/auth";

/**
 * OAuth 1.0a signature generation
 * Uses HMAC-SHA1 to sign the request
 */
function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string = ""
): string {
  // Sort parameters alphabetically
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");

  // Create signature base string
  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join("&");

  // Create signing key
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  // Generate signature
  const signature = createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  return signature;
}

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }

  const consumerKey = process.env.X_CONSUMER_KEY; // API Key
  const consumerSecret = process.env.X_CONSUMER_SECRET; // API Secret
  const callbackUrl = process.env.X_CALLBACK_URL;

  if (!consumerKey || !consumerSecret || !callbackUrl) {
    console.error("[X OAuth 1.0a] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=x_config_missing", process.env.NEXTAUTH_URL)
    );
  }

  try {
    // Step 1: Request a request token
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
    const signature = generateOAuthSignature("POST", requestTokenUrl, oauthParams, consumerSecret);

    oauthParams.oauth_signature = signature;

    // Build Authorization header
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
        new URL("/settings?error=x_request_token_failed", process.env.NEXTAUTH_URL)
      );
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);
    const oauthToken = params.get("oauth_token");
    const oauthTokenSecret = params.get("oauth_token_secret");

    if (!oauthToken || !oauthTokenSecret) {
      console.error("[X OAuth 1.0a] Invalid request token response");
      return NextResponse.redirect(
        new URL("/settings?error=x_invalid_token_response", process.env.NEXTAUTH_URL)
      );
    }

    // Store oauth_token_secret temporarily (in production, use Redis or database)
    // For now, we'll encode it in a cookie or state parameter
    // Note: This is a security consideration - in production, use server-side storage

    console.log("[X OAuth 1.0a] Request token received", {
      userId: user.id,
      oauthToken,
    });

    // Step 2: Redirect user to authorization URL
    const authorizeUrl = new URL("https://api.twitter.com/oauth/authorize");
    authorizeUrl.searchParams.set("oauth_token", oauthToken);

    // Store user ID and token secret for callback
    // In production, store this in Redis with oauth_token as key
    const response2 = NextResponse.redirect(authorizeUrl.toString());
    response2.cookies.set("x_oauth_token_secret", oauthTokenSecret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600, // 10 minutes
    });
    response2.cookies.set("x_user_id", user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
    });

    return response2;
  } catch (error) {
    console.error("[X OAuth 1.0a] Unexpected error:", error);
    return NextResponse.redirect(
      new URL("/settings?error=x_unexpected_error", process.env.NEXTAUTH_URL)
    );
  }
}
