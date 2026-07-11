import type { Platform } from "@prisma/client";
import { PLATFORM_LABELS } from "@/lib/platforms";

/** Longest-prefix match so google_business_profile_* resolves correctly. */
function platformFromCode(code: string): string {
  const match = (Object.keys(PLATFORM_LABELS) as Platform[])
    .filter((key) => code === key || code.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PLATFORM_LABELS[match] : "The account";
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
    if (error.includes("denied")) {
      return {
        variant: "danger",
        message: `You cancelled the ${label} authorization — nothing was connected. Click Connect to try again.`,
      };
    }
    if (error.includes("missing_params") || error.includes("invalid_state")) {
      return {
        variant: "danger",
        message: `The ${label} sign-in couldn't be completed securely. Please try connecting again.`,
      };
    }
    return {
      variant: "danger",
      message: `${label} couldn't be connected. Please try again.`,
    };
  }

  if (success) {
    return { variant: "success", message: `${platformFromCode(success)} connected.` };
  }

  return null;
}
