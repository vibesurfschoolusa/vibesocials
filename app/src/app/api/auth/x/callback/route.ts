import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[X OAuth] Authorization error:", error);
    return NextResponse.redirect(
      new URL(`/connections?error=x_auth_failed`, process.env.NEXTAUTH_URL!)
    );
  }

  if (!code || !state) {
    console.error("[X OAuth] Missing code or state");
    return NextResponse.redirect(
      new URL("/connections?error=x_missing_params", process.env.NEXTAUTH_URL!)
    );
  }

  // Decode and validate state
  let stateData: { userId: string; codeVerifier: string; timestamp: number };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64url").toString());
    
    // Check state is recent (within 10 minutes)
    if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
      throw new Error("State expired");
    }
  } catch (err) {
    console.error("[X OAuth] Invalid state:", err);
    return NextResponse.redirect(
      new URL("/connections?error=x_invalid_state", process.env.NEXTAUTH_URL!)
    );
  }

  const userId = stateData.userId;
  const codeVerifier = stateData.codeVerifier;
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const redirectUri = process.env.X_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[X OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/connections?error=x_config_missing", process.env.NEXTAUTH_URL!)
    );
  }

  try {
    // Exchange authorization code for access token using PKCE
    console.log("[X OAuth] Exchanging code for token", { userId });
    
    // X uses Basic Auth for token endpoint
    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    
    const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${authHeader}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[X OAuth] Token exchange failed", {
        status: tokenResponse.status,
        error: errorText,
      });
      return NextResponse.redirect(
        new URL("/connections?error=x_token_exchange_failed", process.env.NEXTAUTH_URL!)
      );
    }

    const tokenData = await tokenResponse.json();
    console.log("[X OAuth] Token received", {
      expiresIn: tokenData.expires_in,
      scope: tokenData.scope,
      hasRefreshToken: !!tokenData.refresh_token,
    });

    // Get user profile information
    const profileResponse = await fetch("https://api.twitter.com/2/users/me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      console.error("[X OAuth] Failed to fetch profile", {
        status: profileResponse.status,
        error: errorText,
      });
      return NextResponse.redirect(
        new URL("/connections?error=x_profile_failed", process.env.NEXTAUTH_URL!)
      );
    }

    const profileData = await profileResponse.json();
    const profile = profileData.data;
    
    console.log("[X OAuth] Profile fetched", {
      id: profile.id,
      username: profile.username,
      name: profile.name,
    });

    // Calculate token expiration
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    // Store or update social connection
    const existingConnection = await prisma.socialConnection.findFirst({
      where: {
        userId,
        platform: "x",
      },
    });

    if (existingConnection) {
      // Update existing connection
      await prisma.socialConnection.update({
        where: { id: existingConnection.id },
        data: {
          accountIdentifier: profile.id,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || existingConnection.refreshToken,
          expiresAt,
          scopes: tokenData.scope || "tweet.read tweet.write users.read offline.access",
          metadata: {
            username: profile.username,
            name: profile.name,
          },
        },
      });
      console.log("[X OAuth] Connection updated", { connectionId: existingConnection.id });
    } else {
      // Create new connection
      await prisma.socialConnection.create({
        data: {
          userId,
          platform: "x",
          accountIdentifier: profile.id,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          scopes: tokenData.scope || "tweet.read tweet.write users.read offline.access",
          metadata: {
            username: profile.username,
            name: profile.name,
          },
        },
      });
      console.log("[X OAuth] Connection created");
    }

    return NextResponse.redirect(
      new URL("/connections?success=x_connected", process.env.NEXTAUTH_URL!)
    );
  } catch (err) {
    console.error("[X OAuth] Unexpected error:", err);
    return NextResponse.redirect(
      new URL("/connections?error=x_unexpected_error", process.env.NEXTAUTH_URL!)
    );
  }
}
