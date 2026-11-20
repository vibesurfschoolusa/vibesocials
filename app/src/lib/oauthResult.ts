import type { Platform } from "@prisma/client";
import { signInTo } from "@/lib/differentAccount";
import { PLATFORM_LABELS } from "@/lib/platforms";

/**
 * Longest-prefix match so google_business_profile_* resolves correctly.
 * Returns null when the code doesn't start with (or equal) any known
 * platform key — e.g. a raw OAuth provider code like "access_denied" that
 * several callback routes forward unprefixed. Callers supply their own
 * label-less phrasing in that case rather than pairing a fallback noun
 * with a template that already carries its own article.
 */
export function platformFromCode(code: string): Platform | null {
  const match = (Object.keys(PLATFORM_LABELS) as Platform[])
    .filter((key) => code === key || code.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return match ?? null;
}

/**
 * R30 (platform-clients L1): the platform's own ?error= value (access_denied,
 * server_error), for a callback to send after its platform name so the code
 * names the platform. Only a short, plain code is passed on; anything else
 * reads as a failure, never as a cancellation.
 */
export function providerErrorSuffix(raw: string): string {
  return /^[a-z_]{1,40}$/.test(raw) ? raw : "provider_error";
}

function labelFromCode(code: string): string | null {
  const platform = platformFromCode(code);
  return platform ? PLATFORM_LABELS[platform] : null;
}

/**
 * Human-readable outcome for the ?error= / ?success= params every OAuth
 * callback appends to /settings. Returns null when neither is present.
 * Error wins when both are present. `platform` is the platform the code names
 * (null when it names none), so Settings can link to that platform's guide.
 */
/**
 * The banner Settings shows after a connect. R7 review 2: `warning` for a
 * reconnect that worked but changed less than expected (the same end date).
 */
export interface OAuthResult {
  variant: "success" | "warning" | "danger";
  message: string;
  platform: Platform | null;
}

/**
 * R28 (new-customer L6, platform-clients L2): the control a page shows for a
 * platform, so a sentence names only that one. `connect`: no connection, the
 * row shows Connect. `reconnect`: flagged or ending soon, the row shows
 * Reconnect. `connected`: it works, and the row shows neither.
 */
export type ShownControl = "connect" | "reconnect" | "connected";

/** The one rule for {@link ShownControl}, from the platform's connection (none when undefined or null). */
export function shownControl(
  connection: { needsReconnect: boolean; reconnectSoon?: boolean } | null | undefined,
): ShownControl {
  if (!connection) return "connect";
  return connection.needsReconnect || connection.reconnectSoon ? "reconnect" : "connected";
}

/**
 * R29 OO1 (pages L5): the one place a sentence gets the sign-in button's
 * name: the one the row shows, or null when it shows neither (it works).
 */
export function signInButton(shown: ShownControl): "Connect" | "Reconnect" | null {
  if (shown === "connect") return "Connect";
  return shown === "reconnect" ? "Reconnect" : null;
}

/**
 * R29 OO1 lead follow-up: what a cancelled or failed sign-in left, from the
 * shown row. A sign-in that doesn't finish saves nothing, so a row that had a
 * connection keeps it; "nothing was connected" only when there was none.
 * Lower case, no full stop. Settings and the connect link page both use it.
 */
export function signInLeft(shown: ShownControl, label: string | null): string {
  if (shown === "connect") return "nothing was connected";
  return label ? `your ${label} connection is unchanged` : "your existing connection is unchanged";
}

/**
 * R29 OO1 lead follow-up 3: a sign-in that failed with a row present (a
 * Reconnect): the row's connection is unchanged. Null without a row, where
 * each page keeps its own "couldn't connect" sentence. One rule for Settings
 * and the connect link page; each adds its own next step.
 */
export function reconnectFailedText(shown: ShownControl, label: string | null): string | null {
  if (shown === "connect") return null;
  return `We couldn't reconnect ${label ?? "the account"}, so ${signInLeft(shown, label)}.`;
}

function capitalized(sentence: string): string {
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** The step that tries the sign-in once more: "Click Connect again", "Click Reconnect". */
function pressAgain(press: string, button: "Connect" | "Reconnect"): string {
  return button === "Connect" ? `${press} Connect again` : `${press} ${button}`;
}

/**
 * A cause fixed on the platform's side, then the button to try again. A
 * sign-in that fails saves nothing, so a row that had a connection keeps it.
 */
function fixThenTryAgain(fix: string, shown: ShownControl, press: "click" | "press"): string {
  const button = signInButton(shown);
  const step = button ? `${fix}, then ${pressAgain(press, button)}.` : `${fix}.`;
  return shown === "connect" ? step : `${step} Your existing connection is unchanged.`;
}

/**
 * R5 new-customer M1: the account reached the platform but has nothing to
 * post to. Retrying repeats the failure, so the sentence says what to fix
 * first. One table for Settings ("click") and the connect link page ("press").
 */
const CAUSE_FIXES: Record<string, string> = {
  // LinkedIn's organizationAcls answered: the account administers no page
  // (app/api/auth/linkedin/callback/route.ts).
  linkedin_no_admin_pages:
    "This LinkedIn account isn't a Super admin of any company page. Sign in to LinkedIn with an account that is a Super admin of your page",
  // R53 new-customer L2: Facebook returns only the Pages ticked in its list
  // (facebook_page and instagram callbacks), so an empty answer may mean none
  // was ticked. Said as what Facebook returned, with the tick step first.
  facebook_page_no_pages: `Facebook didn't return a Page. ${capitalized(signInTo("facebook_page", "your Facebook Page"))}`,
  instagram_no_instagram_account: `Facebook didn't return a Page with a linked Instagram account. ${capitalized(signInTo("instagram", "your Instagram account"))}. If your Instagram professional account isn't linked to your Page yet, link it first`,
  youtube_no_channel:
    "This Google account has no YouTube channel. Create a channel on YouTube, or sign in with the Google account that owns your channel",
  // Pinterest: a Pin always goes on a board, and GET /boards listed none
  // (app/api/auth/pinterest/callback/route.ts). Secret boards are not listed:
  // the app does not ask for boards:read_secret.
  pinterest_no_boards:
    "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one)",
};

/** Every code {@link causeMessage} words (the connect link page keeps its own list of them). */
export const CAUSE_CODES: readonly string[] = Object.keys(CAUSE_FIXES);

/** The fix-first sentence for `code`, naming the button `shown` gives; null for any other code. */
export function causeMessage(code: string, shown: ShownControl, press: "click" | "press"): string | null {
  return Object.hasOwn(CAUSE_FIXES, code) ? fixThenTryAgain(CAUSE_FIXES[code], shown, press) : null;
}

/** What the callback refused, and the permission to allow on Google's screen. */
const GOOGLE_PERMISSIONS = {
  youtube_upload_not_allowed: { reason: "the permission to upload videos wasn't allowed", allow: "Manage your YouTube videos" },
  // R28 platform-clients L3: channels.list (the channel's name) needs it.
  youtube_readonly_not_allowed: {
    reason: "the permission to see your YouTube account wasn't allowed",
    allow: "View your YouTube account",
  },
} as const;

export type GooglePermissionCode = keyof typeof GOOGLE_PERMISSIONS | "google_business_profile_permission_missing";

export function isGooglePermissionCode(code: string): code is GooglePermissionCode {
  return Object.hasOwn(GOOGLE_PERMISSIONS, code) || code === "google_business_profile_permission_missing";
}

/**
 * The sentence after Google's screen came back without a permission: nothing
 * was saved, so a working connection stays as it was. Settings says "Click",
 * the connect link page (`link`) "Press" and "the Business Profile"; Settings'
 * working Business Profile card has its own sign-in link, the link page none.
 */
export function googlePermissionMessage(code: GooglePermissionCode, shown: ShownControl, page: "settings" | "link"): string {
  const press = page === "settings" ? "Click" : "Press";
  if (code === "google_business_profile_permission_missing") {
    const whose = page === "settings" ? "your" : "the";
    const lead = `Google didn't give Vibe Socials access to ${whose} Business Profile, so nothing changed.`;
    const allow = `on Google's screen, allow access to ${whose} Business Profile.`;
    const card = page === "settings" ? " on the Google Business Profile card" : "";
    const button = signInButton(shown);
    if (button) return `${lead} ${press} ${button}${card} and, ${allow}`;
    return page === "settings"
      ? `${lead} Sign in to Google again from the Google Business Profile card and, ${allow}`
      : `${lead} The Business Profile stays connected as before.`;
  }
  const { reason, allow } = GOOGLE_PERMISSIONS[code];
  const button = signInButton(shown);
  if (!button) return `Nothing changed: ${reason}, and YouTube stays connected as before.`;
  const what = button === "Reconnect" ? "reconnected" : "connected";
  return `YouTube wasn't ${what}: ${reason}. ${pressAgain(press, button)} and, on Google's screen, allow "${allow}".`;
}

/**
 * `shown`: the control the page shows for the platform the code names
 * (R28). Without it, a missing permission reads as before this rule:
 * YouTube's Connect, the Business Profile card's sign-in link.
 */
export function describeOAuthResult(
  params: {
    error: string | null;
    success: string | null;
  },
  options: { shown?: (platform: Platform) => ShownControl } = {},
): OAuthResult | null {
  // `||`, not `??`: describeCode skips an empty error, so this must too.
  const code = params.error || params.success;
  const platform = code ? platformFromCode(code) : null;
  if (params.error && isGooglePermissionCode(params.error) && platform) {
    const fallback: ShownControl = platform === "youtube" ? "connect" : "connected";
    const shown = options.shown ? options.shown(platform) : fallback;
    return { variant: "danger", message: googlePermissionMessage(params.error, shown, "settings"), platform };
  }
  // R29 OO1: a code naming no platform reads as a first Connect, as before.
  const shown = platform && options.shown ? options.shown(platform) : "connect";
  const described = describeCode(params, shown);
  return described && code ? { ...described, platform } : null;
}

function describeCode(
  params: {
    error: string | null;
    success: string | null;
  },
  shown: ShownControl,
): { variant: "success" | "danger"; message: string } | null {
  const { error, success } = params;
  const button = signInButton(shown);

  if (error) {
    // The callback finished in a browser signed in as someone other than the
    // user who started the flow (lib/oauthCallbackGuard.ts). Not
    // platform-prefixed; nothing was connected.
    if (error === "oauth_session_mismatch") {
      return {
        variant: "danger",
        message:
          "That connection was started from a different account. Sign in to the account you want to connect and try again.",
      };
    }
    // Nothing to post to (no page, Page, Instagram account, channel or board).
    const cause = causeMessage(error, shown, "click");
    if (cause) return { variant: "danger", message: cause };
    // R27 platform-clients L3, R27 lead review and R28: a missing Google
    // permission is worded by googlePermissionMessage (describeOAuthResult).

    // F3 (2026-11-14 review): the Connect was clicked in a tab rendered for
    // another workspace, so the start refused it before going to the platform
    // (lib/workspace.ts requireOwnerContextForOAuthStart). This page was
    // loaded fresh, so it already shows the workspace that is active now.
    if (error.endsWith("_workspace_changed")) {
      return {
        variant: "danger",
        message: `That tab was for another workspace, so nothing ${shown === "connect" ? "was connected" : "changed"}. This page shows the workspace you are in now${
          button ? `: ${pressAgain("click", button)} to ${button.toLowerCase()} it here.` : ", where it is already connected."
        }`,
      };
    }
    const label = labelFromCode(error);
    // A "*_denied" code (Google's access_denied, X's auth_denied), or
    // LinkedIn's own "no" (user_cancelled_login, user_cancelled_authorize),
    // which its callback passes on (R44 pages-a L7). Any other provider code
    // is a failure below, never a cancellation.
    if (error.includes("denied") || error.startsWith("linkedin_user_cancelled_")) {
      return {
        variant: "danger",
        message: `You cancelled the ${label ? `${label} ` : ""}authorization — ${signInLeft(shown, label)}.${
          button ? ` Click ${button} to try again.` : ""
        }`,
      };
    }
    // A row present: its connection is unchanged, and the row's button tries again.
    const signInFailed = (): { variant: "danger"; message: string } | null => {
      const failed = reconnectFailedText(shown, label);
      return failed ? { variant: "danger", message: `${failed}${button ? ` Click ${button} to try again.` : ""}` } : null;
    };
    if (error.includes("missing_params") || error.includes("invalid_state")) {
      const failed = signInFailed();
      if (failed) return failed;
      return {
        variant: "danger",
        message: label
          ? `The ${label} sign-in couldn't be completed securely. Please try connecting again.`
          : "The sign-in couldn't be completed securely. Please try connecting again.",
      };
    }
    // Team Workspaces (Task 6, design §5): OAuth start/callback routes are
    // owner-gated; a member hitting one redirects with this code.
    if (error.endsWith("not_workspace_owner")) {
      return {
        variant: "danger",
        message: label
          ? `Only the workspace owner can connect accounts. Ask them to connect ${label}.`
          : "Only the workspace owner can connect accounts. Ask them to connect it.",
      };
    }
    // The platform's OAuth app isn't configured on this deployment (start
    // routes redirect `<platform>_not_configured`). Retrying right away won't
    // help, so the copy says "later" instead of implying a transient failure.
    if (error.endsWith("not_configured")) {
      return {
        variant: "danger",
        message: label
          ? `Connecting ${label} isn't available yet. Please try again later.`
          : "Connecting this account isn't available yet. Please try again later.",
      };
    }
    // Everything else, including the callbacks' unexpected-error code
    // `<platform>_connect_failed` (network/parse/DB failure: transient).
    const failed = signInFailed();
    if (failed) return failed;
    return {
      variant: "danger",
      message: label
        ? `${label} couldn't be connected. Please try again.`
        : "The account couldn't be connected. Please try again.",
    };
  }

  if (success) {
    const label = labelFromCode(success);
    return {
      variant: "success",
      message: label ? `${label} connected.` : "Account connected.",
    };
  }

  return null;
}
