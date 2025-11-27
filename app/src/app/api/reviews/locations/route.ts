import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { refreshAccessToken } from "@/server/googleReviews";

export const dynamic = "force-dynamic";

/**
 * GET /api/reviews/locations - Fetch all Google Business Profile locations for the user
 */
export async function GET() {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get the user's Google Business Profile connection
    const connection = await prisma.socialConnection.findFirst({
      where: {
        userId: user.id,
        platform: "google_business_profile",
      },
    });

    if (!connection) {
      return NextResponse.json(
        { error: "No Google Business Profile connection found" },
        { status: 404 }
      );
    }

    // Check if token is expired and refresh if needed
    const now = new Date();
    let accessToken = connection.accessToken;

    if (connection.expiresAt && new Date(connection.expiresAt) <= now) {
      console.log("[GBP Locations] Access token expired, refreshing...");
      const refreshedConnection = await refreshAccessToken(connection);
      await prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: refreshedConnection.accessToken,
          expiresAt: refreshedConnection.expiresAt,
        },
      });
      accessToken = refreshedConnection.accessToken!;
    }

    // Use the newer Google Business Profile API endpoints
    const accountManagementBase =
      "https://mybusinessaccountmanagement.googleapis.com/v1";
    const businessInfoBase =
      "https://mybusinessbusinessinformation.googleapis.com/v1";

    // Fetch all accounts
    const accountsResponse = await fetch(`${accountManagementBase}/accounts`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!accountsResponse.ok) {
      const errorText = await accountsResponse.text();
      console.error("[GBP Locations] Failed to fetch accounts:", {
        status: accountsResponse.status,
        statusText: accountsResponse.statusText,
        body: errorText.substring(0, 500),
      });
      throw new Error("Failed to fetch Google Business Profile accounts");
    }

    const accountsData = await accountsResponse.json();
    const accounts = accountsData.accounts || [];

    if (accounts.length === 0) {
      return NextResponse.json({ locations: [] });
    }

    // Fetch locations for all accounts
    const allLocations: Array<{
      name: string;
      locationName: string;
      title: string;
      storeCode?: string;
    }> = [];

    for (const account of accounts) {
      const accountName = account.name;
      if (!accountName) continue;

      // Use the business information API with readMask to get location details
      const url = new URL(`${businessInfoBase}/${accountName}/locations`);
      url.searchParams.set("readMask", "name,storeCode,title");

      const locationsResponse = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (locationsResponse.ok) {
        const locationsData = await locationsResponse.json();
        const locations = locationsData.locations || [];

        for (const location of locations) {
          allLocations.push({
            name: location.name, // Full resource name
            locationName: location.locationName || location.title || "Unknown Location",
            title: location.title || location.locationName || "Unknown Location",
            storeCode: location.storeCode,
          });
        }
      } else {
        console.error("[GBP Locations] Failed to fetch locations for account", {
          accountName,
          status: locationsResponse.status,
        });
      }
    }

    console.log("[GBP Locations] Found locations:", allLocations.length);

    return NextResponse.json({
      locations: allLocations,
    });
  } catch (error: any) {
    console.error("[GBP Locations] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch locations" },
      { status: 500 }
    );
  }
}
