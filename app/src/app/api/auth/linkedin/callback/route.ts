import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guardOAuthCallbackSession, oauthCallbackFailed } from "@/lib/oauthCallbackGuard";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import {
  findAdministeredOrganizations,
  lookupOrganization,
  lookupOrganizationByVanityName,
} from "@/server/connections/linkedinOrganizations";
import { createPendingConnection } from "@/server/connections/pendingConnection";
import {
  saveLinkedInConnection,
  type LinkedInOrganization,
  type LinkedInProfile,
} from "@/server/connections/saveConnection";
import { Platform } from "@prisma/client";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    console.error("[LinkedIn OAuth] Authorization error:", error);
    return NextResponse.redirect(
      new URL(`/settings?error=linkedin_auth_failed`, process.env.NEXTAUTH_URL!)
    );
  }

  if (!code || !state) {
    console.error("[LinkedIn OAuth] Missing code or state");
    return NextResponse.redirect(
      new URL("/settings?error=linkedin_missing_params", process.env.NEXTAUTH_URL!)
    );
  }

  // Verify the signed state. userId must come only from the verified HMAC state.
  // An optional vanity-name hint may be appended after a "." separator (unsigned;
  // used only as an organization lookup fallback, never as a source of identity).
  const [signedState, encodedVanityName] = state.split(".");
  const stateCheck = verifyOAuthState(signedState);
  if (!stateCheck.valid || !stateCheck.userId || !stateCheck.workspaceId) {
    console.error("[LinkedIn OAuth] Invalid state");
    return NextResponse.redirect(
      new URL("/settings?error=linkedin_invalid_state", process.env.NEXTAUTH_URL!)
    );
  }

  const userId = stateCheck.userId;
  // Team Workspaces (Task 6, design §5): workspaceId now rides the signed
  // state itself (embedded at /start, verified above) — no separate
  // resolve/provision DB call needed at all, which is what fixes the Task 2
  // review note's "early-resolution quirk": the OLD `resolveWorkspaceForUser`
  // call sat here, before the config check and every LinkedIn API call
  // below, doing a DB round trip that was wasted whenever any of THOSE later
  // steps failed. Reused below at Strategy 4's existing-connection lookup and
  // the final upsert, same two call sites as before.
  const workspaceId = stateCheck.workspaceId;

  try {
    // Connection-CSRF guard: the browser finishing this flow must be signed
    // in as the user carried by the SIGNED state (never the unsigned vanity
    // suffix). Before the code exchange; writes nothing.
    const sessionRedirect = await guardOAuthCallbackSession({
      platform: "linkedin",
      stateUserId: userId,
      baseUrl: process.env.NEXTAUTH_URL!,
    });
    if (sessionRedirect) {
      return sessionRedirect;
    }

    // Re-verify the caller is STILL an owner of this workspace before writing
    // a connection — ownership could have changed between the redirect to
    // LinkedIn and this return trip. Checked here (right after the session
    // check, before the config check and any LinkedIn API calls) so an
    // unauthorized request fails fast instead of spending a token exchange and
    // several organization-lookup calls first.
    if (!(await isWorkspaceOwner(userId, workspaceId))) {
      return NextResponse.redirect(
        new URL("/settings?error=linkedin_not_workspace_owner", process.env.NEXTAUTH_URL!)
      );
    }

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      console.error("[LinkedIn OAuth] Missing environment variables");
      return NextResponse.redirect(
        new URL("/settings?error=linkedin_not_configured", process.env.NEXTAUTH_URL!)
      );
    }

    // Exchange authorization code for access token
    console.log("[LinkedIn OAuth] Exchanging code for token", { userId });
    
    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("[LinkedIn OAuth] Token exchange failed", {
        status: tokenResponse.status,
        error: errorText,
      });
      return NextResponse.redirect(
        new URL("/settings?error=linkedin_token_exchange_failed", process.env.NEXTAUTH_URL!)
      );
    }

    const tokenData = await tokenResponse.json();
    console.log("[LinkedIn OAuth] Token received", {
      expiresIn: tokenData.expires_in,
      scope: tokenData.scope,
    });

    // No member profile: the app requests no profile scope (lib/oauthScopes.ts
    // LINKEDIN_SCOPES) and posts as the company page, so the legacy /v2/me call
    // it used to make always failed. The connection is named after the page.
    const profile: LinkedInProfile = {
      sub: `linkedin_${Date.now()}`,
      name: "LinkedIn User",
      email: null,
      picture: null,
    };

    console.log("[LinkedIn OAuth] Profile data", {
      sub: profile.sub,
      name: profile.name,
      hasEmail: !!profile.email,
    });

    // The company pages the member administers, through LinkedIn's versioned
    // REST APIs (server/connections/linkedinOrganizations.ts). Until 2026-11
    // this tried /v2/organizationalEntityAcls, /v2/organizations?q=roleAssignee
    // and /rest/organizations?q=roleAssignee under the sunset 202405 version;
    // organizationAcls replaces all three.
    let organizations: LinkedInOrganization[] = [];

    // Strategy 1: organizationAcls (approved ADMINISTRATOR roles), with each
    // page's name from GET /rest/organizations/{id}.
    console.log("[LinkedIn OAuth] Attempting to fetch organizations - Strategy 1: organizationAcls");
    const administered = await findAdministeredOrganizations(tokenData.access_token);
    if (administered && administered.length > 0) {
      organizations = administered;
      console.log("[LinkedIn OAuth] Strategy 1 SUCCESS", {
        count: organizations.length,
        orgs: organizations,
      });
    } else {
      console.log("[LinkedIn OAuth] Strategy 1 found no organizations", {
        failed: administered === null,
      });
    }

    // organizationAcls answered, and the member administers no page: that list
    // is LinkedIn's own, so no fallback may connect a page by name (2026-11-09,
    // live: a page found that way refused every post). The fallbacks below are
    // only for when organizationAcls could not be read at all.
    if (administered !== null && administered.length === 0) {
      return NextResponse.redirect(
        new URL("/settings?error=linkedin_no_admin_pages", process.env.NEXTAUTH_URL!)
      );
    }

    // Strategy 2: Check if user has a previous LinkedIn connection with organization data
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Checking for existing LinkedIn connection");
      
      try {
        const existingConnection = await prisma.socialConnection.findUnique({
          where: {
            workspaceId_platform: {
              workspaceId,
              platform: "linkedin" as Platform,
            },
          },
        });
        
        if (existingConnection?.metadata) {
          const metadata = existingConnection.metadata as { organizations?: LinkedInOrganization[] };
          const previousOrgs = metadata.organizations || [];
          
          if (previousOrgs.length > 0 && previousOrgs[0].id !== undefined) {
            console.log("[LinkedIn OAuth] Found organization from previous connection", {
              orgId: previousOrgs[0].id,
              orgName: previousOrgs[0].name,
            });
            
            // Verify the organization is still accessible with new token
            const org = await lookupOrganization(tokenData.access_token, String(previousOrgs[0].id));
            if (org) {
              organizations = [{
                id: org.id,
                name: org.name || previousOrgs[0].name,
                vanityName: org.vanityName || previousOrgs[0].vanityName || null,
              }];
              console.log("[LinkedIn OAuth] Previous organization verified and reused!", organizations[0]);
            } else {
              console.log("[LinkedIn OAuth] Previous organization verification failed");
            }
          }
        }
      } catch (error) {
        console.log("[LinkedIn OAuth] Error checking previous connection:", error);
      }
    }

    // Strategy 3: Check if organization was provided in the state
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Checking for organization in state/session");
      
      // Check if user provided vanity name/ID in the authorization state
      // This will be set if user came from the setup page (appended, unsigned segment)
      const vanityName = encodedVanityName
        ? Buffer.from(encodedVanityName, "base64url").toString("utf8")
        : undefined;
      
      if (vanityName) {
        // Check if it's a numeric ID or a vanity name
        const isNumericId = /^\d+$/.test(vanityName);
        
        if (isNumericId) {
          // Strategy 3a: Direct lookup by numeric organization ID
          console.log("[LinkedIn OAuth] Attempting to lookup organization by ID:", vanityName);
          const org = await lookupOrganization(tokenData.access_token, vanityName);
          if (org) {
            organizations = [{
              id: org.id,
              name: org.name,
              vanityName: org.vanityName || null,
            }];
            console.log("[LinkedIn OAuth] Organization found by ID!", organizations[0]);
          }
        } else {
          // Strategy 3b: Lookup by vanity name
          console.log("[LinkedIn OAuth] Attempting to lookup organization by vanity name:", vanityName);
          const org = await lookupOrganizationByVanityName(tokenData.access_token, vanityName);
          if (org) {
            organizations = [{
              id: org.id,
              name: org.name,
              vanityName: org.vanityName,
            }];
            console.log("[LinkedIn OAuth] Organization found by vanity name!", organizations[0]);
          }
        }
      }
    }

    // If still no organization, redirect to setup page
    if (organizations.length === 0) {
      console.warn("[LinkedIn OAuth] No organizations found - redirecting to setup");
      return NextResponse.redirect(
        new URL(`/settings?linkedin_setup=true`, process.env.NEXTAUTH_URL!)
      );
    }

    console.log("[LinkedIn OAuth] Final organizations result", {
      count: organizations.length,
      organizations,
    });

    // Calculate token expiry
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    const refreshToken: string | null = tokenData.refresh_token || null;
    const scope: string | null = tokenData.scope || null;

    // Several company pages (an agency administering its own and its
    // clients'): connect none of them yet — the user chooses one in Settings.
    if (organizations.length > 1) {
      const pendingId = await createPendingConnection({
        workspaceId,
        userId,
        payload: {
          platform: "linkedin",
          token: {
            accessToken: tokenData.access_token,
            refreshToken,
            expiresAt: expiresAt.toISOString(),
            scope,
          },
          profile,
          organizations,
        },
      });
      console.log("[LinkedIn OAuth] Several organizations found; waiting for the user to choose", {
        userId,
        count: organizations.length,
      });
      return NextResponse.redirect(
        new URL(`/settings?choose=${encodeURIComponent(pendingId)}`, process.env.NEXTAUTH_URL!)
      );
    }

    // Upsert social connection
    await saveLinkedInConnection({
      userId,
      workspaceId,
      token: { accessToken: tokenData.access_token, refreshToken, expiresAt, scope },
      profile,
      organization: organizations[0],
    });

    console.log("[LinkedIn OAuth] Connection saved successfully", { userId });

    return NextResponse.redirect(
      new URL("/settings?success=linkedin_connected", process.env.NEXTAUTH_URL!)
    );
  } catch (error) {
    return oauthCallbackFailed({
      platform: "linkedin",
      baseUrl: process.env.NEXTAUTH_URL!,
      error,
    });
  }
}
