/**
 * Choosing WHICH LinkedIn account gets connected (2026-11-08).
 *
 * LinkedIn's authorization page has no documented way to force a fresh sign-in
 * (https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
 * and once a member has approved the app it approves again silently. So
 * Connect, Reconnect and Switch account always link whichever LinkedIn account
 * is signed in to linkedin.com in this browser. A live connect linked a member
 * who was not an admin of the company page that way, and posting failed.
 *
 * The fix is the same as TikTok's (connection-actions.tsx): sign out of
 * LinkedIn first, then start the connect, so LinkedIn asks who is signing in.
 */

/**
 * LinkedIn's sign-out URL. Signed in: it signs you out. Already signed out: it
 * shows a sign-in page that would sign you out again afterwards, so the steps
 * say to close that tab rather than sign in there.
 */
export const LINKEDIN_SIGN_OUT_URL = "https://www.linkedin.com/m/logout/";

/** Where the connect starts (the OAuth redirect route). */
export const LINKEDIN_CONNECT_URL = "/api/auth/linkedin/start";

export type LinkedInAccountDialogMode = "connect" | "switch";

export interface LinkedInAccountDialogCopy {
  title: string;
  description: string;
  steps: string[];
  shortcut: string;
  continueLabel: string;
}

export function linkedInAccountDialogCopy(mode: LinkedInAccountDialogMode): LinkedInAccountDialogCopy {
  return {
    title: mode === "switch" ? "Switch LinkedIn account" : "Connect LinkedIn",
    description:
      "LinkedIn connects whichever LinkedIn account is signed in to this browser, without asking. To choose the account:",
    steps: [
      "Click “Open LinkedIn sign-out” and sign out in the new tab. If that tab shows a sign-in page instead, you’re already signed out: close it.",
      "Come back here and click Continue. LinkedIn asks you to sign in: use the account that manages your company page.",
    ],
    shortcut: "Already signed in to LinkedIn with the right account? Just click Continue.",
    continueLabel: mode === "switch" ? "Disconnect & continue" : "Continue",
  };
}
