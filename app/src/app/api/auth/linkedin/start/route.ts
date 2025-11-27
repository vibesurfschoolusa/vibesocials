import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error("[LinkedIn OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/connections?error=linkedin_config_missing", process.env.NEXTAUTH_URL)
    );
  }

  // Generate random state for CSRF protection
  const state = Buffer.from(
    JSON.stringify({
      userId: user.id,
      timestamp: Date.now(),
    })
  ).toString("base64url");

  // Build LinkedIn authorization URL
  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  // Using basic LinkedIn scopes that all apps have access to
  // Note: Organization posting (w_organization_social) requires Community Management API product
  // which needs to be explicitly enabled in LinkedIn Developer Portal
  authUrl.searchParams.set(
    "scope",
    "profile email w_member_social"
  );

  console.log("[LinkedIn OAuth] Redirecting to LinkedIn authorization", {
    userId: user.id,
    redirectUri,
  });

  return NextResponse.redirect(authUrl.toString());
}
