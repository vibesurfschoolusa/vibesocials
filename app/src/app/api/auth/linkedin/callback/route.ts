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
      new URL(`/connections?error=linkedin_auth_failed`, process.env.NEXTAUTH_URL!)
    );
  }

  if (!code || !state) {
    console.error("[LinkedIn OAuth] Missing code or state");
    return NextResponse.redirect(
      new URL("/connections?error=linkedin_missing_params", process.env.NEXTAUTH_URL!)
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
      new URL("/connections?error=linkedin_invalid_state", process.env.NEXTAUTH_URL!)
    );
  }

  const userId = stateData.userId;
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[LinkedIn OAuth] Missing environment variables");
    return NextResponse.redirect(
      new URL("/connections?error=linkedin_config_missing", process.env.NEXTAUTH_URL!)
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
        new URL("/connections?error=linkedin_token_exchange_failed", process.env.NEXTAUTH_URL!)
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

    // Fetch user's organizations/company pages using Community Management API
    const orgsResponse = await fetch(
      "https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~(id,localizedName,vanityName)))",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    let organizations: any[] = [];
    if (orgsResponse.ok) {
      const orgsData = await orgsResponse.json();
      organizations = orgsData.elements
        ?.map((element: any) => ({
          id: element["organizationalTarget~"]?.id,
          name: element["organizationalTarget~"]?.localizedName,
          vanityName: element["organizationalTarget~"]?.vanityName,
        }))
        .filter((org: any) => org.id && org.name) || [];
      
      console.log("[LinkedIn OAuth] Organizations fetched", {
        count: organizations.length,
        orgs: organizations,
      });
    } else {
      const errorText = await orgsResponse.text();
      console.warn("[LinkedIn OAuth] Failed to fetch organizations", {
        status: orgsResponse.status,
        error: errorText,
      });
    }

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
      new URL("/connections?success=linkedin_connected", process.env.NEXTAUTH_URL!)
    );
  } catch (error) {
    console.error("[LinkedIn OAuth] Unexpected error:", error);
    return NextResponse.redirect(
      new URL("/connections?error=linkedin_unexpected_error", process.env.NEXTAUTH_URL!)
    );
  }
}
