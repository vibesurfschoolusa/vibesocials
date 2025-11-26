import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }

  const clientId = process.env.X_CLIENT_ID;
  const redirectUri = process.env.X_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error("[X OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/connections?error=x_config_missing", process.env.NEXTAUTH_URL)
    );
  }

  // Generate PKCE code verifier and challenge
  // Code verifier: random string 43-128 characters
  const codeVerifier = randomBytes(32).toString("base64url");
  
  // Code challenge: base64url(sha256(code_verifier))
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Store code verifier and state for validation in callback
  // In production, you'd store this in Redis or a database
  // For now, we'll encode it in the state parameter
  const state = Buffer.from(
    JSON.stringify({
      userId: user.id,
      codeVerifier,
      timestamp: Date.now(),
    })
  ).toString("base64url");

  // Build X authorization URL
  const authUrl = new URL("https://twitter.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  
  // Scopes for X API v2
  // tweet.read: Read tweets
  // tweet.write: Create tweets
  // users.read: Read user profile
  // offline.access: Refresh token for long-lived access
  authUrl.searchParams.set(
    "scope",
    "tweet.read tweet.write users.read offline.access"
  );

  console.log("[X OAuth] Redirecting to X authorization", {
    userId: user.id,
    redirectUri,
  });

  return NextResponse.redirect(authUrl.toString());
}
