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
  const data = (await response.json().catch(() => null)) as { email?: string; error?: string } | null;
  if (response.ok) {
    return {
      undone: true,
      offerRetry: false,
      next: { href: "/forgot-password", label: "Reset your password" },
      title: "The change was undone",
      message: `Your account signs in with ${data?.email ?? "your previous address"} again, and every device was signed out. Reset your password now: whoever changed the email may know it.`,
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
