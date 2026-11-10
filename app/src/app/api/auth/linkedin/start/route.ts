import { NextResponse, NextRequest } from "next/server";
import { LINKEDIN_SCOPES } from "@/lib/oauthScopes";
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
    const url = new URL("/settings", request.url);
    url.searchParams.set("error", "linkedin_not_configured");
    return NextResponse.redirect(url);
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
  // Community Management API scopes only (lib/oauthScopes.ts): LinkedIn
  // allows no other product, such as Sign In with OpenID Connect, on the app.
  authUrl.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));

  console.log("[LinkedIn OAuth] Redirecting to LinkedIn authorization", {
    userId: user.id,
    redirectUri,
  });

  return NextResponse.redirect(authUrl.toString());
}
