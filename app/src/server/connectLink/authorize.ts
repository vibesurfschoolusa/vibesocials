import { createHmac } from "crypto";

import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { META_OAUTH_DIALOG_URL } from "@/lib/metaGraph";
import {
  FACEBOOK_PAGE_SCOPES,
  GOOGLE_BUSINESS_PROFILE_SCOPES,
  INSTAGRAM_SCOPES,
  LINKEDIN_SCOPES,
  YOUTUBE_SCOPES,
} from "@/lib/oauthScopes";
import { buildPinterestAuthorizeUrl, pinterestConfig } from "@/lib/pinterestApi";

/**
 * Where a connect-link flow sends the visitor: the same authorize address,
 * from the same constants and environment variables, as each platform's
 * `/api/auth/<platform>/start` route. Built here rather than shared, so the
 * start routes the platform reviewers test stay untouched; authorize.test.ts
 * compares the two for every platform. LinkedIn's vanity-name suffix is never
 * sent from a link.
 */

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** The authorize address for a state platform, or null when the platform is not configured. */
export function buildLinkAuthorizeUrl(platform: Exclude<Platform, "x">, state: string): string | null {
  switch (platform) {
    case "tiktok": {
      const clientKey = process.env.TIKTOK_CLIENT_KEY;
      const redirectUri = process.env.TIKTOK_REDIRECT_URI;
      if (!clientKey || !redirectUri) return null;
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.searchParams.set("client_key", clientKey);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "user.info.basic,video.publish");
      url.searchParams.set("state", state);
      url.searchParams.set("disable_auto_auth", "1");
      return url.toString();
    }
    case "youtube":
    case "google_business_profile": {
      const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
      const redirectUri =
        platform === "youtube" ? process.env.YOUTUBE_REDIRECT_URI : process.env.GOOGLE_GBP_REDIRECT_URI;
      if (!clientId || !redirectUri) return null;
      const scopes = platform === "youtube" ? YOUTUBE_SCOPES : GOOGLE_BUSINESS_PROFILE_SCOPES;
      const url = new URL(GOOGLE_AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "instagram":
    case "facebook_page": {
      const clientId = process.env.FACEBOOK_APP_ID;
      const redirectUri =
        platform === "instagram" ? process.env.INSTAGRAM_REDIRECT_URI : process.env.FACEBOOK_PAGE_REDIRECT_URI;
      if (!clientId || !redirectUri) return null;
      const scopes = platform === "instagram" ? INSTAGRAM_SCOPES : FACEBOOK_PAGE_SCOPES;
      const url = new URL(META_OAUTH_DIALOG_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "linkedin": {
      const clientId = process.env.LINKEDIN_CLIENT_ID;
      const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
      if (!clientId || !redirectUri) return null;
      const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
      return url.toString();
    }
    case "pinterest": {
      const config = pinterestConfig();
      if (!config) return null;
      return buildPinterestAuthorizeUrl({ appId: config.appId, redirectUri: config.redirectUri, state });
    }
  }
}

/** OAuth 1.0a HMAC-SHA1 signature, as the X start route makes it. */
function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  const base = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join("&");
  return createHmac("sha1", `${encodeURIComponent(consumerSecret)}&`).update(base).digest("base64");
}

/** As the X start route: the handshake row lives 10 minutes. */
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TOKEN_URL = "https://api.twitter.com/oauth/request_token";

/**
 * X has no state: asks X for a request token exactly as the start route does,
 * and stores the handshake row as the link's creator with the link id and
 * nonce, which the callback compares with the visitor's cookie. Returns the
 * authorize address, or null when X is not configured or refuses.
 */
export async function startXLinkFlow({
  linkId,
  nonce,
  userId,
  workspaceId,
}: {
  linkId: string;
  nonce: string;
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const consumerKey = process.env.X_CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET;
  const callbackUrl = process.env.X_CALLBACK_URL;
  if (!consumerKey || !consumerSecret || !callbackUrl) return null;

  const oauthParams: Record<string, string> = {
    oauth_callback: callbackUrl,
    oauth_consumer_key: consumerKey,
    oauth_nonce: Math.random().toString(36).substring(2),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };
  oauthParams.oauth_signature = oauthSignature("POST", REQUEST_TOKEN_URL, oauthParams, consumerSecret);
  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${key}="${encodeURIComponent(oauthParams[key])}"`)
      .join(", ");

  const response = await fetch(REQUEST_TOKEN_URL, { method: "POST", headers: { Authorization: authHeader } });
  if (!response.ok) {
    logger.error("[connect-link] X refused the request token", { status: response.status, connectLinkId: linkId });
    return null;
  }
  const params = new URLSearchParams(await response.text());
  const oauthToken = params.get("oauth_token");
  const oauthTokenSecret = params.get("oauth_token_secret");
  if (!oauthToken || !oauthTokenSecret) {
    logger.error("[connect-link] X's request-token answer had no token", { connectLinkId: linkId });
    return null;
  }

  await prisma.oAuthHandshake.create({
    data: {
      token: oauthToken,
      tokenSecret: oauthTokenSecret,
      userId,
      workspaceId,
      expiresAt: new Date(Date.now() + HANDSHAKE_TTL_MS),
      connectLinkId: linkId,
      connectLinkNonce: nonce,
    },
  });

  const authorizeUrl = new URL("https://api.twitter.com/oauth/authorize");
  authorizeUrl.searchParams.set("oauth_token", oauthToken);
  return authorizeUrl.toString();
}
