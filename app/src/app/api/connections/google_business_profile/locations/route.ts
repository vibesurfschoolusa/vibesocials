import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Platform, type SocialConnection } from "@prisma/client";

export const runtime = "nodejs";

interface GbpAccount {
  name?: string | null; // "accounts/{accountId}"
  accountName?: string | null;
}

interface GbpLocation {
  name?: string | null; // "locations/{locationId}" or similar
  title?: string | null;
  storeCode?: string | null;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string | null;
    administrativeArea?: string | null;
    regionCode?: string | null;
    postalCode?: string | null;
  } | null;
}

async function refreshAccessToken(
  connection: SocialConnection,
): Promise<SocialConnection | null> {
  const refreshToken = connection.refreshToken;
  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    return null;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenRes.ok) {
      console.error("[GBP] Failed to refresh access token", {
        status: tokenRes.status,
        statusText: tokenRes.statusText,
      });
      return null;
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!tokenJson.access_token) {
      console.error("[GBP] Refresh response missing access_token");
      return null;
    }

    const now = Date.now();
    const expiresAt = tokenJson.expires_in
      ? new Date(now + tokenJson.expires_in * 1000)
      : null;

    const updated = await prisma.socialConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: tokenJson.access_token,
        expiresAt,
      },
    });

    return updated;
  } catch (error) {
    console.error("[GBP] Unexpected error while refreshing access token", { error });
    return null;
  }
}

export async function GET(_request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let connection = await prisma.socialConnection.findFirst({
    where: {
      userId: user.id,
      platform: Platform.google_business_profile,
    },
  });

  if (!connection) {
    return NextResponse.json(
      { error: "No Google Business Profile connection found" },
      { status: 400 },
    );
  }

  let accessToken = connection.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "Missing access token for Google Business Profile" },
      { status: 400 },
    );
  }

  const makeAuthHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
  });

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  try {
    // 1. List all accounts the user has access to.
    let accountsRes = await fetch(`${accountManagementBase}/accounts`, {
      headers: makeAuthHeaders(accessToken),
    });

    // If the token is expired or invalid, try to refresh it once.
    if (accountsRes.status === 401) {
      const refreshed = await refreshAccessToken(connection);
      if (refreshed && refreshed.accessToken) {
        connection = refreshed;
        accessToken = refreshed.accessToken;
        accountsRes = await fetch(`${accountManagementBase}/accounts`, {
          headers: makeAuthHeaders(accessToken),
        });
      }
    }

    if (!accountsRes.ok) {
      console.error("[GBP] accounts.list failed while listing locations", {
        status: accountsRes.status,
        statusText: accountsRes.statusText,
      });
      return NextResponse.json(
        { error: "Failed to list Google Business Profile accounts" },
        { status: 502 },
      );
    }

    const accountsJson = (await accountsRes.json()) as {
      accounts?: GbpAccount[];
    };

    const accounts = accountsJson.accounts ?? [];
    const allLocations: {
      resourceName: string;
      title: string | null;
      storeCode: string | null;
      address: string | null;
      accountName: string | null;
    }[] = [];

    // 2. For each account, list its locations via Business Information API.
    for (const account of accounts) {
      const accountName = account.name ?? undefined; // "accounts/{accountId}"
      if (!accountName) continue;

      const accountLabel = account.accountName ?? accountName;

      const url = new URL(`${businessInfoBase}/${accountName}/locations`);
      url.searchParams.set("readMask", "name,title,storeCode,storefrontAddress");

      const locationsRes = await fetch(url.toString(), {
        headers: makeAuthHeaders(accessToken),
      });

      if (!locationsRes.ok) {
        console.error("[GBP] accounts.locations.list failed", {
          accountName,
          status: locationsRes.status,
          statusText: locationsRes.statusText,
        });
        continue;
      }

      const locationsJson = (await locationsRes.json()) as {
        locations?: GbpLocation[];
      };

      const locations = locationsJson.locations ?? [];

      for (const loc of locations) {
        if (!loc.name) continue;

        // loc.name is typically "locations/{locationId}" for the Business Information API.
        const rawLocationName = loc.name;

        const locationId = rawLocationName.startsWith("locations/")
          ? rawLocationName.slice("locations/".length)
          : rawLocationName;

        const [, accountId] = accountName.split("/");
        const fullResourceName = accountId
          ? `accounts/${accountId}/locations/${locationId}`
          : `${accountName}/${locationId}`;

        const addr = loc.storefrontAddress ?? undefined;
        const addressParts: string[] = [];

        if (addr?.addressLines && addr.addressLines.length > 0) {
          addressParts.push(addr.addressLines.join(" "));
        }
        if (addr?.locality) addressParts.push(addr.locality);
        if (addr?.administrativeArea) addressParts.push(addr.administrativeArea);
        if (addr?.regionCode) addressParts.push(addr.regionCode);
        if (addr?.postalCode) addressParts.push(addr.postalCode);

        allLocations.push({
          resourceName: fullResourceName,
          title: loc.title ?? null,
          storeCode: loc.storeCode ?? null,
          address: addressParts.join(", ") || null,
          accountName: accountLabel,
        });
      }
    }

    return NextResponse.json({ locations: allLocations });
  } catch (error) {
    console.error("[GBP] Unexpected error while listing locations", { error });
    return NextResponse.json(
      { error: "Unexpected error while listing Google Business Profile locations" },
      { status: 500 },
    );
  }
}
