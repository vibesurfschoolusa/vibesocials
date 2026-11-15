/**
 * What /verify-email/undo says after the person presses its button (R5
 * new-customer L4, review). The route's refusals (used, expired, the email
 * changed again, another account took the address) are plain sentences
 * already (api/auth/change-email/undo), so they are shown as they are.
 */

export type UndoView = {
  undone: boolean;
  title: string;
  message: string;
  next: { href: string; label: string };
  /** A "Try again" button: nothing was changed and the link still works. */
  offerRetry: boolean;
};

const HOME = { href: "/", label: "Go to Vibe Socials" };

export async function undoEmailChange(fetchImpl: typeof fetch, token: string): Promise<UndoView> {
  const notUndone = { undone: false, next: HOME, offerRetry: false };
  if (!token) {
    return {
      ...notUndone,
      title: "This link isn't valid",
      message: "This link is missing its code. Open the link from the email again.",
    };
  }
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/change-email/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return {
      ...notUndone,
      offerRetry: true,
      title: "We couldn't reach Vibe Socials",
      message: "Nothing was changed, and this link still works. Check your internet connection, then press Try again.",
    };
  }
  const data = (await response.json().catch(() => null)) as
    | { email?: string; resetSent?: boolean; error?: string }
    | null;
  if (response.ok) {
    // The undo cleared the password (the person who made the change knew
    // it), so the way back in is the reset link sent to this address.
    const address = data?.email ?? "your previous address";
    const resetSent = data?.resetSent === true;
    return {
      undone: true,
      offerRetry: false,
      next: resetSent
        ? { href: "/forgot-password", label: "Send another reset link" }
        : { href: "/forgot-password", label: "Reset your password" },
      title: "The change was undone",
      message: resetSent
        ? `Your email is back to ${address}. We sent a password reset link there; set a new password to sign in.`
        : `Your email is back to ${address}. We couldn't send a password reset link just now: press Reset your password below to get one, then set a new password to sign in.`,
    };
  }
  const serverFailed = response.status >= 500;
  return {
    ...notUndone,
    offerRetry: serverFailed,
    title: serverFailed ? "Something went wrong on our side" : "The change wasn't undone",
    message:
      data?.error ??
      (serverFailed
        ? "Nothing was changed, and this link still works. Please try again in a minute."
        : "Nothing was changed. Open the link from the email again."),
  };
}
