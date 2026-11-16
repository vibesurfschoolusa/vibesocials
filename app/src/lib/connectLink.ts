import type { Platform } from "@prisma/client";

import {
  causeMessage,
  googlePermissionMessage,
  isGooglePermissionCode,
  reconnectFailedText,
  signInLeft,
  type ShownControl,
} from "@/lib/oauthResult";
import { PLATFORM_LABELS, PLATFORM_ORDER } from "@/lib/platforms";

/**
 * Client connect link (2026-11-11): the pure parts shared by the owner routes,
 * the public routes under /api/connect-link/[token]/, the callback wrapper and
 * the /c/[token] page.
 *
 * A link flow acts as the link's creator in the link's workspace, so the
 * callbacks' own owner re-check and writes apply unchanged.
 */

/** What a callback is told about a link flow it is finishing. */
export interface ConnectLinkFlow {
  /** The WorkspaceConnectLink id. */
  id: string;
  /** The random value both the state (or X's handshake row) and the cookie carry. */
  nonce: string;
  /** The link's creator: the flow acts as this owner. */
  userId: string;
  workspaceId: string;
  /** The raw token, only to send the visitor back to their page. Never logged or put in a state. */
  token: string;
}

/** The browser's sealed proof that it started this flow on the link's page. */
export const CONNECT_LINK_COOKIE = "vs_connect";
/** 15 minutes: long enough for a platform's screens, short enough to go stale. */
export const CONNECT_LINK_COOKIE_MAX_AGE_SECONDS = 15 * 60;
/** A link works for 14 days from creation. */
export const CONNECT_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** New links one owner makes in an hour. */
export const CONNECT_LINK_CREATES_PER_HOUR = 10;
/** Connect presses from one network in an hour. */
export const CONNECT_LINK_STARTS_PER_HOUR = 30;
/** Connect presses one link takes in an hour, from any network. */
export const CONNECT_LINK_STARTS_PER_LINK_PER_HOUR = 60;
/** Choice requests (list, choose, cancel) from one network in an hour. */
export const CONNECT_LINK_CHOICES_PER_HOUR = 60;

/** Unknown, revoked, expired and paused links all read the same. */
export const CONNECT_LINK_INACTIVE_MESSAGE =
  "This link is not active. Ask the person who sent it to you for a new link.";

export const CONNECT_LINK_REOPEN_MESSAGE =
  "This link has expired or was opened in a different browser. Open the link you were sent again.";

export const CONNECT_LINK_CREATE_LIMIT_MESSAGE = "Too many new links in the last hour. Try again later.";

export const CONNECT_LINK_RATE_LIMIT_MESSAGE =
  "Too many requests from this network in the last hour. Try again later.";

/** The per-link limit can refuse a visitor on a fresh network, so it names the link, not the network. */
export const CONNECT_LINK_USED_TOO_OFTEN_MESSAGE =
  "This link was used too many times in the last hour. Try again later.";

export const CONNECT_LINK_PLATFORMS_REQUIRED_MESSAGE = "Choose at least one platform the link offers.";

export const CONNECT_LINK_PLATFORM_UNAVAILABLE_MESSAGE =
  "One of the chosen platforms can't be connected on this site yet. Untick it and try again.";

export function connectLinkUrl(baseUrl: string | undefined, token: string): string {
  return `${baseUrl ?? ""}/c/${token}`;
}

/** Tokens are 32 random bytes as base64url: anything else is not worth a lookup. */
export function isConnectLinkTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Every environment variable a platform's start AND callback read. A platform
 * missing any of them is not offered and not shown: the visitor could not get
 * past the callback's own configuration check.
 */
const PLATFORM_ENV: Record<Platform, readonly string[]> = {
  tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"],
  youtube: ["GOOGLE_GBP_CLIENT_ID", "GOOGLE_GBP_CLIENT_SECRET", "YOUTUBE_REDIRECT_URI"],
  google_business_profile: ["GOOGLE_GBP_CLIENT_ID", "GOOGLE_GBP_CLIENT_SECRET", "GOOGLE_GBP_REDIRECT_URI"],
  instagram: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_REDIRECT_URI"],
  facebook_page: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "FACEBOOK_PAGE_REDIRECT_URI"],
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI"],
  pinterest: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET", "PINTEREST_REDIRECT_URI"],
  x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_CALLBACK_URL"],
};

type Env = Record<string, string | undefined>;

export function connectLinkPlatformConfigured(platform: Platform, env: Env = process.env): boolean {
  const names = PLATFORM_ENV[platform];
  return !!names && names.every((name) => !!env[name]?.trim());
}

export function configuredConnectLinkPlatforms(env: Env = process.env): Platform[] {
  return PLATFORM_ORDER.filter((platform) => connectLinkPlatformConfigured(platform, env));
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORM_ORDER as readonly string[]).includes(value);
}

export type ParsedConnectLinkPlatforms = { ok: true; platforms: Platform[] } | { ok: false; error: string };

/** The platforms an owner ticked: at least one, each known and configured; returned once each, in app order. */
export function parseConnectLinkPlatforms(value: unknown, env: Env = process.env): ParsedConnectLinkPlatforms {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: CONNECT_LINK_PLATFORMS_REQUIRED_MESSAGE };
  }
  if (!value.every(isPlatform)) {
    return { ok: false, error: CONNECT_LINK_PLATFORM_UNAVAILABLE_MESSAGE };
  }
  if (!value.every((platform) => connectLinkPlatformConfigured(platform, env))) {
    return { ok: false, error: CONNECT_LINK_PLATFORM_UNAVAILABLE_MESSAGE };
  }
  return { ok: true, platforms: PLATFORM_ORDER.filter((platform) => value.includes(platform)) };
}

/** The error code for a platform the workspace already has a working connection for. */
export function alreadyConnectedCode(platform: Platform): string {
  return `${platform}_already_connected`;
}

/**
 * The error code for a link flow the visitor said no to on the platform's own
 * screen. Only the callback wrapper sets it, from the platform's parameters.
 */
export function cancelledCode(platform: Platform): string {
  return `${platform}_cancelled`;
}

/** The error code for a link flow that failed for a reason the visitor cannot act on. */
export function connectFailedCode(platform: Platform): string {
  return `${platform}_connect_failed`;
}

/** Longest prefix wins, so google_business_profile_* is not read as some shorter name. */
function platformOfCode(code: string): Platform | null {
  return (
    PLATFORM_ORDER.filter((platform) => code === platform || code.startsWith(`${platform}_`)).sort(
      (a, b) => b.length - a.length,
    )[0] ?? null
  );
}

const LINKEDIN_NO_PAGE_CODE = "linkedin_no_admin_pages";

/**
 * Causes the visitor can fix on the platform's side, worded by the table
 * Settings uses (lib/oauthResult.ts causeMessage) with this page's "press";
 * they never mention Settings.
 */
const VISITOR_CAUSES: ReadonlySet<string> = new Set([
  "facebook_page_no_pages",
  "instagram_no_instagram_account",
  LINKEDIN_NO_PAGE_CODE,
  "pinterest_no_boards",
]);

export type ConnectLinkResult = { variant: "success" | "danger"; message: string };

/**
 * The one sentence at the top of the visitor's page after a flow, from the
 * query the callback (through the wrapper) sent them back with. Never shows a
 * code. A waiting choice (`choose=`) is shown by the page itself. The one to
 * ask is "the person who sent you this link": the workspace is named after the
 * client's own business, so its name would point the visitor at themselves.
 * `locationKept`: the connection already has its Business Profile location
 * (a reconnect keeps it), so nobody has one to choose (R14-client-journey L2).
 */
export function describeConnectLinkResult(
  query: URLSearchParams,
  { locationKept = false, shown }: { locationKept?: boolean; shown?: (platform: Platform) => ShownControl } = {},
): ConnectLinkResult | null {
  const error = query.get("error");
  const success = query.get("success");

  if (!error && query.get("linkedin_setup")) {
    return { variant: "danger", message: causeMessage(LINKEDIN_NO_PAGE_CODE, shown ? shown("linkedin") : "connect", "press")! };
  }

  if (error) {
    const platform = platformOfCode(error);
    const label = platform ? PLATFORM_LABELS[platform] : null;

    // R29 OO1 lead follow-up: with a row (a Reconnect), its connection is
    // unchanged; "Nothing was connected" only when there was none.
    const rowShown: ShownControl = platform && shown ? shown(platform) : "connect";
    if (platform && error === cancelledCode(platform)) {
      const left = signInLeft(rowShown, label);
      return {
        variant: "danger",
        message: rowShown === "connect" ? `You cancelled. ${left[0].toUpperCase()}${left.slice(1)}.` : `You cancelled, so ${left}.`,
      };
    }
    if (platform && error === alreadyConnectedCode(platform)) {
      return { variant: "danger", message: `${label} is already connected. Ask the person who sent you this link if it should be changed.` };
    }
    // R28 new-customer L6: a missing Google permission names the row's own button.
    if (platform && isGooglePermissionCode(error)) {
      // Without `shown`, as before this rule: YouTube's Connect, the Business Profile's Reconnect.
      const fallback: ShownControl = platform === "youtube" ? "connect" : "reconnect";
      return { variant: "danger", message: googlePermissionMessage(error, shown ? shown(platform) : fallback, "link") };
    }
    // R29 OO1 lead follow-up: the page shows Reconnect on a flagged or
    // ending-soon row, so the cause names the row's own button.
    const cause = platform && VISITOR_CAUSES.has(error) ? causeMessage(error, shown ? shown(platform) : "connect", "press") : null;
    if (cause) return { variant: "danger", message: cause };
    const tellThem = "Try again, or tell the person who sent you this link.";
    const failed = reconnectFailedText(rowShown, label);
    if (failed) return { variant: "danger", message: `${failed} ${tellThem}` };
    return {
      variant: "danger",
      message: label ? `We couldn't connect ${label}. ${tellThem}` : `We couldn't connect the account. ${tellThem}`,
    };
  }

  if (success) {
    const platform = platformOfCode(success);
    if (!platform) return { variant: "success", message: "The account is connected." };
    const connected = `${PLATFORM_LABELS[platform]} is connected.`;
    return {
      variant: "success",
      message:
        platform === "google_business_profile" && !locationKept
          ? `${connected} The person who sent you this link will choose the business location.`
          : connected,
    };
  }

  return null;
}
