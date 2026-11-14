/**
 * R2-client-journey L2: /go opened by someone who is not a member of the
 * link's workspace lands on the dashboard with `?notice=other-workspace`, and
 * the dashboard says why. The address carries only this fixed word: the email
 * shown comes from the session, and no workspace is named, so the notice tells
 * nothing about a workspace the person cannot open.
 */
export const OTHER_WORKSPACE_NOTICE = "other-workspace";

/** The dashboard's sentence for `?notice=`, or null for no notice. */
export function homeNotice(notice: string | string[] | undefined, email: string): string | null {
  if (notice !== OTHER_WORKSPACE_NOTICE) return null;
  return `That link is for another workspace. You are signed in as ${email}; sign in with the account that belongs to it.`;
}
