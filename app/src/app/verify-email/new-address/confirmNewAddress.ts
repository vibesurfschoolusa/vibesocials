import { answerLostText } from "@/lib/answerLost";
import { addressHeldSentence, emailChangeLockedSentence } from "@/lib/displayDate";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

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
  /** A "Try again" button: the link may not be used up, and a used one then says so. */
  offerRetry: boolean;
};

const SETTINGS = { href: "/settings", label: "Go to Settings" };
const LOG_IN = { href: "/login", label: "Log in" };

type ConfirmAnswer = {
  viewer?: string;
  email?: string;
  error?: string;
  used?: boolean;
  reason?: string;
  until?: string;
};

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
    response = await fetchOrNoAnswer(
      "/api/auth/change-email/confirm",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
      fetchImpl,
    );
  } catch {
    // R28 NN2: the change may have been made before the answer was lost; Try
    // again then says the link was already used.
    return {
      ...notChanged,
      offerRetry: true,
      title: "Vibe Socials didn't answer",
      message: answerLostText("your sign-in email may have changed", "Then press Try again to see."),
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
  // R6-pages L1: most likely opened again by whoever just used it, so the
  // title doesn't say the email is unchanged.
  if (data?.used === true && data.error) {
    return { ...notChanged, title: "This link was already used", message: data.error };
  }
  // R29 OO1 (security L2): a link the route can't find may have been used, so
  // the title claims nothing either way; the route's sentence says what to do.
  if (data?.reason === "not_valid" && data.error) {
    return { ...notChanged, title: "This link can't be used", message: data.error };
  }
  // R6-security M1: the undo-window refusals, written again from `until` so
  // the date is in the viewer's time zone rather than the server's.
  if (typeof data?.until === "string" && (data.reason === "locked" || data.reason === "held")) {
    const sentence = data.reason === "locked" ? emailChangeLockedSentence : addressHeldSentence;
    return { ...notChanged, title: "Your email wasn't changed", message: sentence(data.until) };
  }
  const serverFailed = response.status >= 500;
  return {
    ...notChanged,
    offerRetry: serverFailed,
    title: serverFailed ? "Something went wrong on our side" : "Your email wasn't changed",
    message:
      data?.error ??
      (serverFailed
        ? "Your sign-in email may not have changed. Press Try again in a minute to see."
        : "Your email is unchanged. To change it, ask again in Settings, Account."),
  };
}
