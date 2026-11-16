import { withWorkspaceId } from "@/lib/workspaceChanged";

/**
 * JJ3 lead review: when Google stops accepting a connection that is not
 * flagged, the fix is signing in again in place. This is the Reconnect
 * button's own OAuth start (connection-actions.tsx). Its callback updates the
 * existing row: new tokens, the flag cleared, the chosen location and the
 * listing's daily numbers kept (saveConnection.ts; a location the new sign-in
 * can't use is cleared for the chooser). Switch account disconnects first,
 * which deletes the listing's numbers and the chosen location
 * (api/connections/[platform]), so an error never sends anyone there for a
 * sign-in problem.
 */
export const GBP_SIGN_IN_PATH = "/api/auth/google_business_profile/start";

/** Settings' Google Business Profile card (connections-section.tsx), for owner links from Google failures. */
export const GBP_CARD_ID = "google-business-profile";
export const GBP_CARD_HREF = `/settings#${GBP_CARD_ID}`;

/** The in-place sign-in for a workspace. */
export function gbpSignInUrl(workspaceId: string): string {
  return withWorkspaceId(GBP_SIGN_IN_PATH, workspaceId);
}

/** A sign-in URL read from an answer, only when it is that start URL; else null. */
export function safeGbpSignInUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(`${GBP_SIGN_IN_PATH}?`) ? value : null;
}
