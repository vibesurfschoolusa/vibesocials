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
function platformFromCode(code: string): string | null {
  const match = (Object.keys(PLATFORM_LABELS) as Platform[])
    .filter((key) => code === key || code.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PLATFORM_LABELS[match] : null;
}

/**
 * Human-readable outcome for the ?error= / ?success= params every OAuth
 * callback appends to /settings. Returns null when neither is present.
 * Error wins when both are present.
 */
export function describeOAuthResult(params: {
  error: string | null;
  success: string | null;
}): { variant: "success" | "danger"; message: string } | null {
  const { error, success } = params;

  if (error) {
    const label = platformFromCode(error);
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
    return {
      variant: "danger",
      message: label
        ? `${label} couldn't be connected. Please try again.`
        : "The account couldn't be connected. Please try again.",
    };
  }

  if (success) {
    const label = platformFromCode(success);
    return {
      variant: "success",
      message: label ? `${label} connected.` : "Account connected.",
    };
  }

  return null;
}
