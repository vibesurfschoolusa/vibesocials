import { withWorkspaceId } from "@/lib/workspaceChanged";

/**
 * JJ3 lead review: when Google stops accepting a connection that is not
 * flagged, the fix is signing in again in place. This is the Reconnect
 * button's own OAuth start (connection-actions.tsx). Its callback updates the
 * existing row: new tokens, the flag cleared, the listing's daily numbers kept
 * (saveConnection.ts). The chosen location is kept too, unless the Google
 * account signed in to can't read it: then it is cleared for the chooser.
 * Switch account disconnects first, which deletes the listing's numbers and
 * the chosen location (api/connections/[platform]), so an error never sends
 * anyone there for a sign-in problem.
 *
 * The routes only say a sign-in is needed (`signIn: true`). The browser builds
 * the URL from the workspace its page was drawn for, as the Reconnect button
 * does: the start route refuses any other workspace (workspace.ts
 * requireOwnerContextForOAuthStart), so a tab drawn for client A never signs
 * client B in after the owner switched workspaces in another tab.
 */
export const GBP_SIGN_IN_PATH = "/api/auth/google_business_profile/start";

/** Settings' Google Business Profile card (connections-section.tsx), for owner links from Google failures. */
export const GBP_CARD_ID = "google-business-profile";
export const GBP_CARD_HREF = `/settings#${GBP_CARD_ID}`;

/** The in-place sign-in for the workspace the page was drawn for. */
export function gbpSignInUrl(workspaceId: string): string {
  return withWorkspaceId(GBP_SIGN_IN_PATH, workspaceId);
}
