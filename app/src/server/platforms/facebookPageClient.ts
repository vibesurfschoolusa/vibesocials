import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { markConnectionNeedsReconnect } from "./connectionHealth";

// Token-material reality (see app/api/auth/facebook_page/callback/route.ts):
// `accessToken` is a Facebook PAGE access token minted from a long-lived user
// token during OAuth, `refreshToken` is always null (the user token is never
// stored), and `expiresAt` records the USER token's ~60-day expiry — not the
// page token's. Page tokens minted this way generally do not expire, so unlike
// instagramClient.ts there is deliberately NO preemptive expiry guard here (it
// would falsely block still-working connections at day 60). The real health
// signal is the Graph API rejecting the token at publish time: HTTP 401, or an
// `OAuthException` with code 190 (invalid/expired token, commonly HTTP 400) —
// both are mapped below to a clean, coded reconnect error plus the
// `needsReconnect` flag (Roadmap Phase 4, see connectionHealth.ts).

const FACEBOOK_PAGE_RECONNECT_CODE = "FACEBOOK_PAGE_RECONNECT_REQUIRED";

function facebookPageReconnectRequiredError(): Error & { code: string } {
  const error = new Error(
    "Your Facebook Page connection is no longer valid — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = FACEBOOK_PAGE_RECONNECT_CODE;
  return error;
}

/**
 * True when a Graph API error body is an auth failure that only a reconnect
 * can fix: an `OAuthException` with code 190 (invalid/expired access token).
 * Facebook frequently returns these with HTTP 400, so status alone is not
 * enough. Exported for tests.
 */
export function isFacebookAuthErrorBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; code?: number };
    };
    return (
      parsed.error?.type === "OAuthException" && parsed.error?.code === 190
    );
  } catch {
    return false;
  }
}

export const facebookPageClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Facebook Page") as Error & { code: string };
      error.code = "FACEBOOK_PAGE_NO_ACCESS_TOKEN";
      throw error;
    }

    const pageId = socialConnection.accountIdentifier;
    if (!pageId) {
      const error = new Error("Missing Facebook Page ID") as Error & { code: string };
      error.code = "FACEBOOK_PAGE_NO_ID";
      throw error;
    }

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("image/")) {
      const error = new Error(
        "Facebook Page posting currently supports images only. Please upload an image.",
      ) as Error & { code: string };
      error.code = "FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE";
      throw error;
    }

    console.log("[FacebookPage] Starting photo publish", {
      pageId,
      storageLocation: mediaItem.storageLocation,
      captionLength: caption?.length ?? 0,
    });

    const endpoint = new URL(`https://graph.facebook.com/v21.0/${pageId}/photos`);

    const body = new URLSearchParams({
      url: mediaItem.storageLocation,
      caption: caption ?? "",
      access_token: accessToken,
    });

    const response = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      // COR-3 discipline (matches instagramClient.ts): raw upstream bodies go
      // to server logs only — PostJobResult.errorMessage renders in the UI, so
      // the thrown message carries just a prefix + status.
      const errorBody = await response
        .text()
        .catch(() => "Unable to read error body");
      console.error("[FacebookPage] Photo publish failed", {
        status: response.status,
        error: errorBody,
      });
      // Token no longer accepted -> the actionable reconnect error, and flag
      // the connection so the dashboard/settings Reconnect affordance lights
      // up instead of the user retrying a dead token forever.
      if (response.status === 401 || isFacebookAuthErrorBody(errorBody)) {
        await markConnectionNeedsReconnect(
          socialConnection.id,
          FACEBOOK_PAGE_RECONNECT_CODE,
        );
        throw facebookPageReconnectRequiredError();
      }
      const error = new Error(
        `Facebook Page photo publish failed (status ${response.status})`,
      ) as Error & { code: string };
      error.code = "FACEBOOK_PAGE_PUBLISH_FAILED";
      throw error;
    }

    const data = (await response.json()) as { id?: string };
    const externalPostId = data.id ?? null;

    console.log("[FacebookPage] Photo published successfully", {
      pageId,
      externalPostId,
    });

    return {
      externalPostId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    // Nothing to refresh: no user token is stored (refreshToken is null) and
    // the page token itself does not expire on a schedule — see the
    // token-material note at the top of this file. A genuinely dead token is
    // detected and flagged at publish time above.
    return connection;
  },
};
