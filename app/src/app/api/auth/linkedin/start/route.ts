import { NextResponse, NextRequest } from "next/server";
import { createOAuthState } from "@/lib/oauthState";
import { requireOwnerContextForOAuthStart } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const contextOrRedirect = await requireOwnerContextForOAuthStart(
    request,
    "linkedin_not_workspace_owner",
  );
  if (contextOrRedirect instanceof NextResponse) {
    return contextOrRedirect;
  }
  if (!contextOrRedirect) {
    return NextResponse.redirect(new URL("/login", process.env.NEXTAUTH_URL));
  }
  const { user, workspace } = contextOrRedirect;

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

  // Sign the state with the canonical HMAC helper (userId + workspaceId are
  // signed, tamper-proof). An optional vanity-name hint is appended as a
  // separate, non-sensitive segment; it is only used as a lookup fallback and
  // never as a source of identity.
  let state = createOAuthState({ userId: user.id, workspaceId: workspace.id });

  if (vanityName) {
    state = `${state}.${Buffer.from(vanityName, "utf8").toString("base64url")}`;
    console.log("[LinkedIn OAuth] Including vanity name in state:", vanityName);
  }

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
