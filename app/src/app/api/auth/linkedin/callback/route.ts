import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyOAuthState } from "@/lib/oauthState";
import { isWorkspaceOwner } from "@/lib/workspace";
import { Platform, Prisma } from "@prisma/client";

// Minimal shapes for the LinkedIn responses this handler reads. Only the fields
// actually used are modeled; everything else is ignored.
interface LinkedInProfile {
  sub: string;
  name: string;
  email: string | null;
  picture: string | null;
}

interface LinkedInOrganization {
  id?: string;
  name?: string;
  vanityName?: string | null;
}

interface LinkedInAclElement {
  "organizationalTarget~"?: {
    id?: string;
    localizedName?: string;
    vanityName?: string;
  };
}

interface LinkedInOrgElement {
  id?: string;
  organizationId?: string;
  localizedName?: string;
  name?: string;
  vanityName?: string;
}

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

  // Re-verify the caller is STILL an owner of this workspace before writing
  // a connection — ownership could have changed between the redirect to
  // LinkedIn and this return trip. Checked here (right after state
  // verification, before the config check and any LinkedIn API calls) so an
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
      new URL("/settings?error=linkedin_config_missing", process.env.NEXTAUTH_URL!)
    );
  }

  try {
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

    // Note: We're using ONLY organization scopes (no profile/email scopes)
    // Development Tier Community Management API may not support member profile scopes
    // We'll use a minimal profile based on what's available or use organization info
    
    // Try to fetch basic profile (may fail without profile scopes)
    let profile: LinkedInProfile | null = null;
    try {
      const profileResponse = await fetch("https://api.linkedin.com/v2/me", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      });

      if (profileResponse.ok) {
        const profileData = await profileResponse.json();
        profile = {
          sub: profileData.id,
          name: `${profileData.localizedFirstName || ""} ${profileData.localizedLastName || ""}`.trim(),
          email: null, // No email scope
          picture: null,
        };
      }
    } catch (error) {
      console.warn("[LinkedIn OAuth] Could not fetch profile (no profile scopes)");
    }

    // If we couldn't get profile, use minimal placeholder
    if (!profile) {
      profile = {
        sub: `linkedin_${Date.now()}`, // Temporary ID, will be updated when we fetch orgs
        name: "LinkedIn User",
        email: null,
        picture: null,
      };
    }

    console.log("[LinkedIn OAuth] Profile data", {
      sub: profile.sub,
      name: profile.name,
      hasEmail: !!profile.email,
    });

    // Try multiple endpoints to fetch organizations (Community Management API limitations)
    let organizations: LinkedInOrganization[] = [];
    
    // Strategy 1: Try organizationalEntityAcls endpoint (requires specific permissions)
    console.log("[LinkedIn OAuth] Attempting to fetch organizations - Strategy 1: organizationalEntityAcls");
    try {
      const acls = await fetch(
        "https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~(id,localizedName,vanityName)))",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "X-Restli-Protocol-Version": "2.0.0",
          },
        }
      );

      if (acls.ok) {
        const aclsData = await acls.json() as { elements?: LinkedInAclElement[] };
        organizations = aclsData.elements
          ?.map((element) => ({
            id: element["organizationalTarget~"]?.id,
            name: element["organizationalTarget~"]?.localizedName,
            vanityName: element["organizationalTarget~"]?.vanityName,
          }))
          .filter((org) => org.id && org.name) || [];
        
        console.log("[LinkedIn OAuth] Strategy 1 SUCCESS", {
          count: organizations.length,
          orgs: organizations,
        });
      } else {
        console.log("[LinkedIn OAuth] Strategy 1 failed:", acls.status);
      }
    } catch (error) {
      console.log("[LinkedIn OAuth] Strategy 1 error:", error);
    }

    // Strategy 2: Try organizations lookup API with roleAssignee
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Attempting Strategy 2: organizations?q=roleAssignee");
      try {
        const orgsLookup = await fetch(
          "https://api.linkedin.com/v2/organizations?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(id,localizedName,vanityName))",
          {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "X-Restli-Protocol-Version": "2.0.0",
            },
          }
        );

        if (orgsLookup.ok) {
          const lookupData = await orgsLookup.json() as { elements?: LinkedInOrgElement[] };
          organizations = lookupData.elements
            ?.map((org) => ({
              id: org.id,
              name: org.localizedName,
              vanityName: org.vanityName,
            }))
            .filter((org) => org.id && org.name) || [];
          
          console.log("[LinkedIn OAuth] Strategy 2 SUCCESS", {
            count: organizations.length,
            orgs: organizations,
          });
        } else {
          console.log("[LinkedIn OAuth] Strategy 2 failed:", orgsLookup.status);
        }
      } catch (error) {
        console.log("[LinkedIn OAuth] Strategy 2 error:", error);
      }
    }

    // Strategy 3: Try REST API with newer versioning
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Attempting Strategy 3: REST API /rest/organizations");
      try {
        const restOrgs = await fetch(
          "https://api.linkedin.com/rest/organizations?q=roleAssignee",
          {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "LinkedIn-Version": "202405",
            },
          }
        );

        if (restOrgs.ok) {
          const restData = await restOrgs.json() as { elements?: LinkedInOrgElement[] };
          organizations = restData.elements
            ?.map((org) => ({
              id: org.id || org.organizationId,
              name: org.localizedName || org.name,
              vanityName: org.vanityName,
            }))
            .filter((org) => org.id && org.name) || [];
          
          console.log("[LinkedIn OAuth] Strategy 3 SUCCESS", {
            count: organizations.length,
            orgs: organizations,
          });
        } else {
          console.log("[LinkedIn OAuth] Strategy 3 failed:", restOrgs.status);
        }
      } catch (error) {
        console.log("[LinkedIn OAuth] Strategy 3 error:", error);
      }
    }

    // Strategy 4: Check if user has a previous LinkedIn connection with organization data
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
          
          if (previousOrgs.length > 0) {
            console.log("[LinkedIn OAuth] Found organization from previous connection", {
              orgId: previousOrgs[0].id,
              orgName: previousOrgs[0].name,
            });
            
            // Verify the organization is still accessible with new token
            try {
              const orgVerify = await fetch(
                `https://api.linkedin.com/v2/organizations/${previousOrgs[0].id}`,
                {
                  headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    "X-Restli-Protocol-Version": "2.0.0",
                  },
                }
              );
              
              if (orgVerify.ok) {
                const org = await orgVerify.json();
                organizations = [{
                  id: org.id,
                  name: org.localizedName || org.name || previousOrgs[0].name,
                  vanityName: org.vanityName || previousOrgs[0].vanityName || null,
                }];
                console.log("[LinkedIn OAuth] Previous organization verified and reused!", organizations[0]);
              } else {
                console.log("[LinkedIn OAuth] Previous organization verification failed:", orgVerify.status);
              }
            } catch (error) {
              console.log("[LinkedIn OAuth] Previous organization verification error:", error);
            }
          }
        }
      } catch (error) {
        console.log("[LinkedIn OAuth] Error checking previous connection:", error);
      }
    }

    // Strategy 5: Check if organization was provided in the state
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
          // Strategy 5a: Direct lookup by numeric organization ID
          console.log("[LinkedIn OAuth] Attempting to lookup organization by ID:", vanityName);
          try {
            const orgLookup = await fetch(
              `https://api.linkedin.com/v2/organizations/${vanityName}`,
              {
                headers: {
                  Authorization: `Bearer ${tokenData.access_token}`,
                  "X-Restli-Protocol-Version": "2.0.0",
                },
              }
            );

            if (orgLookup.ok) {
              const org = await orgLookup.json();
              organizations = [{
                id: org.id,
                name: org.localizedName || org.name,
                vanityName: org.vanityName || null,
              }];
              console.log("[LinkedIn OAuth] Organization found by ID!", organizations[0]);
            } else {
              console.log("[LinkedIn OAuth] ID lookup failed:", orgLookup.status);
            }
          } catch (error) {
            console.log("[LinkedIn OAuth] ID lookup error:", error);
          }
        } else {
          // Strategy 5b: Lookup by vanity name
          console.log("[LinkedIn OAuth] Attempting to lookup organization by vanity name:", vanityName);
          try {
            const orgLookup = await fetch(
              `https://api.linkedin.com/v2/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
              {
                headers: {
                  Authorization: `Bearer ${tokenData.access_token}`,
                  "X-Restli-Protocol-Version": "2.0.0",
                },
              }
            );

            if (orgLookup.ok) {
              const lookupData = await orgLookup.json();
              const org = lookupData.elements?.[0];
              if (org) {
                organizations = [{
                  id: org.id,
                  name: org.localizedName || org.name,
                  vanityName: org.vanityName,
                }];
                console.log("[LinkedIn OAuth] Organization found by vanity name!", organizations[0]);
              }
            } else {
              console.log("[LinkedIn OAuth] Vanity name lookup failed:", orgLookup.status);
            }
          } catch (error) {
            console.log("[LinkedIn OAuth] Vanity name lookup error:", error);
          }
        }
      }
    }

    // Strategy 6: Fallback to environment variable
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Checking environment variables");
      const linkedinOrgId = process.env.LINKEDIN_ORGANIZATION_ID;
      const linkedinOrgName = process.env.LINKEDIN_ORGANIZATION_NAME || "Company Page";
      
      if (linkedinOrgId) {
        organizations = [{
          id: linkedinOrgId,
          name: linkedinOrgName,
          vanityName: null,
        }];
        console.log("[LinkedIn OAuth] Using manually configured organization", {
          id: linkedinOrgId,
          name: linkedinOrgName,
        });
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

    // Upsert social connection
    await prisma.socialConnection.upsert({
      where: {
        workspaceId_platform: {
          workspaceId,
          platform: "linkedin",
        },
      },
      create: {
        userId,
        workspaceId,
        platform: "linkedin",
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt,
        accountIdentifier: profile.sub,
        scopes: tokenData.scope || "w_organization_social r_organization_social",
        metadata: {
          name: profile.name,
          email: profile.email,
          picture: profile.picture,
          organizations,
        } as unknown as Prisma.InputJsonValue,
        // Roadmap Phase 4: a fresh connect always starts in a healthy state.
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
      update: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt,
        scopes: tokenData.scope || "w_organization_social r_organization_social",
        metadata: {
          name: profile.name,
          email: profile.email,
          picture: profile.picture,
          organizations,
        } as unknown as Prisma.InputJsonValue,
        // Roadmap Phase 4: successful reconnect clears the flag set by a
        // prior refresh/COR-5 failure (see server/platforms/connectionHealth.ts).
        needsReconnect: false,
        lastRefreshErrorCode: null,
        refreshFailedAt: null,
      },
    });

    console.log("[LinkedIn OAuth] Connection saved successfully", { userId });

    return NextResponse.redirect(
      new URL("/settings?success=linkedin_connected", process.env.NEXTAUTH_URL!)
    );
  } catch (error) {
    console.error("[LinkedIn OAuth] Unexpected error:", error);
    return NextResponse.redirect(
      new URL("/settings?error=linkedin_unexpected_error", process.env.NEXTAUTH_URL!)
    );
  }
}
