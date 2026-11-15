/**
 * What /verify-email/new-address says after the person presses its button
 * and the token is posted (R5 new-customer L4). The route's refusals are
 * already plain sentences (api/auth/change-email/confirm), so they are shown
 * as they are.
 */

export type NewAddressView = {
  changed: boolean;
  /**
   * Clear this browser's session: only when it is signed in to the account
   * that changed (the server already signed that account out everywhere).
   * Someone signed in to another account stays signed in.
   */
  signOutHere: boolean;
  title: string;
  message: string;
  next: { href: string; label: string };
  /** A "Try again" button: the link was not used up. */
  offerRetry: boolean;
};

const SETTINGS = { href: "/settings", label: "Go to Settings" };
const LOG_IN = { href: "/login", label: "Log in" };

type ConfirmAnswer = { viewer?: string; email?: string; error?: string };

export async function confirmNewAddress(fetchImpl: typeof fetch, token: string): Promise<NewAddressView> {
  const notChanged = { changed: false, signOutHere: false, next: SETTINGS, offerRetry: false };
  if (!token) {
    return {
      ...notChanged,
      title: "This link isn't valid",
      message:
        "This link is missing its code. Open the link from the newest email again, or ask for the change again in Settings, Account.",
    };
  }
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/change-email/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return {
      ...notChanged,
      offerRetry: true,
      title: "We couldn't reach Vibe Socials",
      message:
        "Your email is unchanged, and this link still works. Check your internet connection, then press Try again.",
    };
  }
  const data = (await response.json().catch(() => null)) as ConfirmAnswer | null;
  if (response.ok) {
    const title = "Your sign-in email was changed";
    if (data?.viewer === "other_account") {
      return {
        changed: true,
        signOutHere: false,
        offerRetry: false,
        next: { href: "/", label: "Continue to Vibe Socials" },
        title,
        message:
          "The sign-in email of that account was changed. Whoever uses it logs in again with the new address. You are still signed in here.",
      };
    }
    return {
      changed: true,
      signOutHere: data?.viewer === "this_account",
      offerRetry: false,
      next: LOG_IN,
      title,
      message: `You now sign in with ${data?.email ?? "your new address"}. Every device was signed out, so log in again with the new address.`,
    };
  }
  const serverFailed = response.status >= 500;
  return {
    ...notChanged,
    offerRetry: serverFailed,
    title: serverFailed ? "Something went wrong on our side" : "Your email wasn't changed",
    message:
      data?.error ??
      (serverFailed
        ? "Your email is unchanged, and this link still works. Please try again in a minute."
        : "Your email is unchanged. To change it, ask again in Settings, Account."),
  };
}
