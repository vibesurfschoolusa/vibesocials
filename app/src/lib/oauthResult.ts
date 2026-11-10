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
export function describeOAuthResult(params: {
  error: string | null;
  success: string | null;
}): { variant: "success" | "danger"; message: string; platform: Platform | null } | null {
  const code = params.error ?? params.success;
  const described = describeCode(params);
  return described && code ? { ...described, platform: platformFromCode(code) } : null;
}

function describeCode(params: {
  error: string | null;
  success: string | null;
}): { variant: "success" | "danger"; message: string } | null {
  const { error, success } = params;

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
        message:
          "This LinkedIn account isn't a Super admin of any company page. Sign in to LinkedIn with an account that is a Super admin of your page, then click Connect again.",
      };
    }
    // Pinterest: a Pin always goes on a board, and GET /boards listed none
    // (app/api/auth/pinterest/callback/route.ts). Secret boards are not listed:
    // the app does not ask for boards:read_secret.
    if (error === "pinterest_no_boards") {
      return {
        variant: "danger",
        message:
          "This Pinterest account has no board we can post to, and every Pin goes on a board. Create a board on Pinterest (not a secret one), then click Connect again.",
      };
    }
    const label = labelFromCode(error);
    // LinkedIn's own "user declined" redirect uses a fixed linkedin_auth_failed
    // code rather than a "*_denied" one — catch it too so it reads as a
    // cancellation instead of a generic failure.
    if (error.includes("denied") || error.endsWith("auth_failed")) {
      return {
        variant: "danger",
        message: label
          ? `You cancelled the ${label} authorization — nothing was connected. Click Connect to try again.`
          : "You cancelled the authorization — nothing was connected. Click Connect to try again.",
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
