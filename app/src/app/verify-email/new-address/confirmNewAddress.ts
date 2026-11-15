/**
 * What /verify-email/new-address says after it posts the link's token
 * (R5 new-customer L4). The route's refusals are already plain sentences
 * (api/auth/change-email/confirm), so they are shown as they are.
 */

export type NewAddressView = {
  changed: boolean;
  title: string;
  message: string;
  next: { href: string; label: string };
  /** A "Try again" button: the link was not used up. */
  offerRetry: boolean;
};

const SETTINGS = { href: "/settings", label: "Go to Settings" };

export async function confirmNewAddress(fetchImpl: typeof fetch, token: string): Promise<NewAddressView> {
  const notChanged = { changed: false, next: SETTINGS, offerRetry: false };
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
  const data = (await response.json().catch(() => null)) as { email?: string; error?: string } | null;
  if (response.ok) {
    return {
      changed: true,
      offerRetry: false,
      next: { href: "/login", label: "Log in" },
      title: "Your sign-in email was changed",
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
