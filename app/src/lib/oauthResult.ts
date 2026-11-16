import type { Platform } from "@prisma/client";
import { PLATFORM_LABELS } from "@/lib/platforms";

/**
 * Longest-prefix match so google_business_profile_* resolves correctly.
 * Returns null when the code doesn't start with (or equal) any known
 * platform key — e.g. a raw OAuth provider code like "access_denied" that
 * several callback routes forward unprefixed. Callers supply their own
 * label-less phrasing in that case rather than pairing a fallback noun
 * with a template that already carries its own article.
 */
function platformFromCode(code: string): Platform | null {
  const match = (Object.keys(PLATFORM_LABELS) as Platform[])
    .filter((key) => code === key || code.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return match ?? null;
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

/** The step that tries the sign-in once more: "Click Connect again", "Click Reconnect". */
function pressAgain(press: string, button: "Connect" | "Reconnect"): string {
  return button === "Connect" ? `${press} Connect again` : `${press} ${button}`;
}

/**
 * A cause fixed on the platform's side, then the button to try again. A
 * sign-in that fails saves nothing, so a row that had a connection keeps it.
 */
function fixThenTryAgain(fix: string, shown: ShownControl): string {
  const button = signInButton(shown);
  const step = button ? `${fix}, then ${pressAgain("click", button)}.` : `${fix}.`;
  return shown === "connect" ? step : `${step} Your existing connection is unchanged.`;
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
    // LinkedIn's organizationAcls answered: the account administers no page
    // (app/api/auth/linkedin/callback/route.ts).
    if (error === "linkedin_no_admin_pages") {
      return {
        variant: "danger",
        message: fixThenTryAgain(
          "This LinkedIn account isn't a Super admin of any company page. Sign in to LinkedIn with an account that is a Super admin of your page",
          shown,
        ),
      };
    }
    // R5 new-customer M1: the account reached the platform but has nothing
    // to post to. Retrying repeats the failure, so say what to fix first. The
    // Meta sentences match the connect link page's (lib/connectLink.ts).
    const NOTHING_TO_POST_TO: Record<string, string> = {
      facebook_page_no_pages:
        "This Facebook account doesn't manage a Facebook Page. Sign in to Facebook with an account that manages your Page",
      instagram_no_instagram_account:
        "None of the Facebook Pages on this account has an Instagram professional account linked to it. Link your Instagram account to your Facebook Page",
      youtube_no_channel:
        "This Google account has no YouTube channel. Create a channel on YouTube, or sign in with the Google account that owns your channel",
    };
    if (Object.hasOwn(NOTHING_TO_POST_TO, error)) {
      return { variant: "danger", message: fixThenTryAgain(NOTHING_TO_POST_TO[error], shown) };
    }
    // R27 platform-clients L3, R27 lead review and R28: a missing Google
    // permission is worded by googlePermissionMessage (describeOAuthResult).

    // Pinterest: a Pin always goes on a board, and GET /boards listed none
    // (app/api/auth/pinterest/callback/route.ts). Secret boards are not listed:
    // the app does not ask for boards:read_secret.
    if (error === "pinterest_no_boards") {
      return {
        variant: "danger",
        message: fixThenTryAgain(
          "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one)",
          shown,
        ),
      };
    }
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
    // LinkedIn's own "user declined" redirect uses a fixed linkedin_auth_failed
    // code rather than a "*_denied" one — catch it too so it reads as a
    // cancellation instead of a generic failure.
    if (error.includes("denied") || error.endsWith("auth_failed")) {
      return {
        variant: "danger",
        message: `You cancelled the ${label ? `${label} ` : ""}authorization — ${
          shown === "connect" ? "nothing was connected" : "your existing connection is unchanged"
        }.${button ? ` Click ${button} to try again.` : ""}`,
      };
    }
    if (error.includes("missing_params") || error.includes("invalid_state")) {
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
