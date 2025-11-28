import { NextResponse, NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error("[LinkedIn OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/settings?error=linkedin_config_missing", process.env.NEXTAUTH_URL)
    );
  }

  // Check if user provided a vanity name for organization lookup
  const searchParams = request.nextUrl.searchParams;
  const vanityName = searchParams.get("vanity_name");

  // Generate random state for CSRF protection (include vanity name if provided)
  const stateData: any = {
    userId: user.id,
    timestamp: Date.now(),
  };

  if (vanityName) {
    stateData.linkedinVanityName = vanityName;
    console.log("[LinkedIn OAuth] Including vanity name in state:", vanityName);
  }

  const state = Buffer.from(JSON.stringify(stateData)).toString("base64url");

  // Build LinkedIn authorization URL
  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  // Using ONLY Community Management API organization scopes
  // IMPORTANT: OpenID Connect and Community Management API are mutually exclusive
  // Development Tier may only support organization scopes, not member profile scopes
  // Testing with minimal org scopes that Community Management API explicitly provides
  authUrl.searchParams.set(
    "scope",
    "w_organization_social r_organization_social"
  );

  console.log("[LinkedIn OAuth] Redirecting to LinkedIn authorization", {
    userId: user.id,
    redirectUri,
  });

  return NextResponse.redirect(authUrl.toString());
}
