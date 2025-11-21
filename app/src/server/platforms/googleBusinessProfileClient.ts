import type { SocialConnection } from "@prisma/client";

import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Google Business Profile client (photos that appear on Google Maps)
//
// This client uses the Google Business Profile API to create media for a
// specific business location (locationName in SocialConnection.metadata) so
// photos appear on Google Maps.

export const googleBusinessProfileClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Google Business Profile");
      (error as any).code = "GBP_NO_ACCESS_TOKEN";
      throw error;
    }

    // Google Business Profile primarily supports photos
    // Videos may not be supported or may require different permissions
    if (mediaItem.mimeType && !mediaItem.mimeType.startsWith("image/")) {
      console.warn("[GBP] Attempting to upload non-image media", {
        mimeType: mediaItem.mimeType,
        originalFilename: mediaItem.originalFilename,
      });
    }

    const { locationName } = await ensureLocationName(socialConnection, accessToken);

    const apiBase = "https://mybusiness.googleapis.com";
    const commonAuthHeaders = {
      Authorization: `Bearer ${accessToken}`,
    } as const;

    // 1. Start upload to get a MediaItemDataRef resourceName.
    const startUploadRes = await fetch(
      `${apiBase}/v4/${locationName}/media:startUpload`,
      {
        method: "POST",
        headers: {
          ...commonAuthHeaders,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    if (!startUploadRes.ok) {
      const errorBody = await startUploadRes.text().catch(() => "Unable to read error body");
      console.error("[GBP] media:startUpload failed", {
        status: startUploadRes.status,
        statusText: startUploadRes.statusText,
        locationName,
        errorBody,
      });
      const error = new Error(`Failed to start Google Business Profile upload: ${errorBody}`);
      (error as any).code = "GBP_START_UPLOAD_FAILED";
      throw error;
    }

    const startUploadJson = (await startUploadRes.json()) as { resourceName?: string };
    const dataRefResourceName = startUploadJson.resourceName;
    if (!dataRefResourceName) {
      const error = new Error("Google Business Profile did not return a media resourceName");
      (error as any).code = "GBP_NO_MEDIA_RESOURCE_NAME";
      throw error;
    }

    // 2. Fetch the media file from Vercel Blob (storageLocation is now a URL)
    const mediaUrl = mediaItem.storageLocation;
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      const error = new Error("Failed to fetch media from storage");
      (error as any).code = "GBP_FETCH_MEDIA_FAILED";
      throw error;
    }
    
    const fileBytes = Buffer.from(await mediaResponse.arrayBuffer());

    // 3. Upload the media bytes using the upload endpoint.
    const uploadRes = await fetch(
      `${apiBase}/upload/v1/media/${encodeURIComponent(dataRefResourceName)}?upload_type=media`,
      {
        method: "POST",
        headers: {
          ...commonAuthHeaders,
          "Content-Type": mediaItem.mimeType || "application/octet-stream",
        },
        body: fileBytes,
      },
    );

    if (!uploadRes.ok) {
      console.error("[GBP] media bytes upload failed", {
        status: uploadRes.status,
        statusText: uploadRes.statusText,
      });
      const error = new Error("Failed to upload media bytes to Google Business Profile");
      (error as any).code = "GBP_UPLOAD_FAILED";
      throw error;
    }

    // 4. Create the media item for the location.
    const isPhoto = mediaItem.mimeType?.startsWith("image/") ?? true;
    const mediaFormat = isPhoto ? "PHOTO" : "VIDEO";
    const category = isPhoto ? "COVER" : "ADDITIONAL";

    const createRes = await fetch(`${apiBase}/v4/${locationName}/media`, {
      method: "POST",
      headers: {
        ...commonAuthHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mediaFormat,
        locationAssociation: {
          category,
        },
        dataRef: {
          resourceName: dataRefResourceName,
        },
      }),
    });

    if (!createRes.ok) {
      console.error("[GBP] media create failed", {
        status: createRes.status,
        statusText: createRes.statusText,
      });
      const error = new Error("Failed to create media item in Google Business Profile");
      (error as any).code = "GBP_CREATE_MEDIA_FAILED";
      throw error;
    }

    const created = (await createRes.json()) as { name?: string };
    const externalPostId = created.name ?? null;

    return {
      externalPostId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    // TODO: Implement real token refresh using Google OAuth if needed.
    return connection;
  },
};

async function ensureLocationName(
  socialConnection: SocialConnection,
  accessToken: string,
): Promise<{ locationName: string }> {
  const metadata = (socialConnection.metadata as any) ?? {};
  const raw = metadata.locationName;

  if (typeof raw !== "string" || !raw.trim()) {
    const error = new Error(
      "Google Business Profile location is not configured. Set it from the Connections page.",
    );
    (error as any).code = "GBP_NO_LOCATION_NAME";
    throw error;
  }

  const trimmed = raw.trim();

  // If the user pasted the full resource name, use it as-is.
  if (trimmed.startsWith("accounts/")) {
    return { locationName: trimmed };
  }

  // Otherwise treat it as a Store code from Advanced settings and resolve it.
  const resolved = await resolveLocationNameFromStoreCode(accessToken, trimmed);
  return { locationName: resolved };
}

async function resolveLocationNameFromStoreCode(
  accessToken: string,
  identifier: string,
): Promise<string> {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  } as const;

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  // 1. List all accounts the user has access to.
  const accountsRes = await fetch(`${accountManagementBase}/accounts`, {
    headers: authHeaders,
  });

  if (!accountsRes.ok) {
    console.error("[GBP] accounts.list failed while resolving store code", {
      status: accountsRes.status,
      statusText: accountsRes.statusText,
    });
    const error = new Error(
      "Failed to list Google Business Profile accounts while resolving location.",
    );
    (error as any).code = "GBP_ACCOUNTS_LIST_FAILED";
    throw error;
  }

  const accountsJson = (await accountsRes.json()) as {
    accounts?: { name?: string }[];
  };

  const accounts = accountsJson.accounts ?? [];
  const candidates: string[] = [];

  // 2. For each account, search locations by storeCode.
  for (const account of accounts) {
    const accountName = account.name; // e.g. "accounts/123456789012345678901"
    if (!accountName) continue;

    const url = new URL(`${businessInfoBase}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,storeCode,title");
    url.searchParams.set("filter", `storeCode="${identifier}"`);

    const locationsRes = await fetch(url.toString(), {
      headers: authHeaders,
    });

    if (!locationsRes.ok) {
      console.error("[GBP] accounts.locations.list failed for account", {
        accountName,
        status: locationsRes.status,
        statusText: locationsRes.statusText,
      });
      continue;
    }

    const locationsJson = (await locationsRes.json()) as {
      locations?: { name?: string; storeCode?: string }[];
    };

    const locations = locationsJson.locations ?? [];
    for (const loc of locations) {
      if (!loc.name) continue;
      if (loc.storeCode !== identifier) continue;

      // loc.name is "locations/{locationId}"
      const locationId = loc.name.startsWith("locations/")
        ? loc.name.slice("locations/".length)
        : loc.name;
      const [, accountId] = accountName.split("/");
      if (!accountId) continue;

      candidates.push(`accounts/${accountId}/locations/${locationId}`);
    }
  }

  if (candidates.length === 0) {
    const error = new Error(
      "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
    );
    (error as any).code = "GBP_STORE_CODE_NOT_FOUND";
    throw error;
  }

  if (candidates.length > 1) {
    const error = new Error(
      "Store code matched multiple Google Business Profile locations. Please specify a more precise identifier.",
    );
    (error as any).code = "GBP_STORE_CODE_NOT_UNIQUE";
    throw error;
  }

  return candidates[0];
}
