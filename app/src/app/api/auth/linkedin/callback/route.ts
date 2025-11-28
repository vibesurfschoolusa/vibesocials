import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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

  // Decode and validate state
  let stateData: { userId: string; timestamp: number };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64url").toString());
    
    // Check state is recent (within 10 minutes)
    if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
      throw new Error("State expired");
    }
  } catch (err) {
    console.error("[LinkedIn OAuth] Invalid state:", err);
    return NextResponse.redirect(
      new URL("/settings?error=linkedin_invalid_state", process.env.NEXTAUTH_URL!)
    );
  }

  const userId = stateData.userId;
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
    let profile: any = null;
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
    let organizations: any[] = [];
    
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
        const aclsData = await acls.json();
        organizations = aclsData.elements
          ?.map((element: any) => ({
            id: element["organizationalTarget~"]?.id,
            name: element["organizationalTarget~"]?.localizedName,
            vanityName: element["organizationalTarget~"]?.vanityName,
          }))
          .filter((org: any) => org.id && org.name) || [];
        
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
          const lookupData = await orgsLookup.json();
          organizations = lookupData.elements
            ?.map((org: any) => ({
              id: org.id,
              name: org.localizedName,
              vanityName: org.vanityName,
            }))
            .filter((org: any) => org.id && org.name) || [];
          
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
          const restData = await restOrgs.json();
          organizations = restData.elements
            ?.map((org: any) => ({
              id: org.id || org.organizationId,
              name: org.localizedName || org.name,
              vanityName: org.vanityName,
            }))
            .filter((org: any) => org.id && org.name) || [];
          
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

    // Strategy 4: Check if organization was provided in the state
    if (organizations.length === 0) {
      console.log("[LinkedIn OAuth] Checking for organization in state/session");
      
      // Check if user provided vanity name/ID in the authorization state
      // This will be set if user came from the setup page
      const stateData = JSON.parse(Buffer.from(state || "", "base64url").toString());
      const vanityName = stateData.linkedinVanityName;
      
      if (vanityName) {
        // Check if it's a numeric ID or a vanity name
        const isNumericId = /^\d+$/.test(vanityName);
        
        if (isNumericId) {
          // Strategy 4a: Direct lookup by numeric organization ID
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
          // Strategy 4b: Lookup by vanity name
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

    // Strategy 5: Fallback to environment variable
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
        userId_platform: {
          userId,
          platform: "linkedin",
        },
      },
      create: {
        userId,
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
        },
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
        },
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
