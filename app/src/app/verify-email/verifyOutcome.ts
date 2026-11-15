/**
 * What the verify-email page says after it tries the link (R5 new-customer
 * L3, pages L7). The verify route answers one uniform 400 for every dead
 * link (no oracle, api/auth/verify-email), so the page tells the cases apart
 * from what it can know itself: the answer's status, whether the request got
 * through at all, and whether the signed-in person is verified. A used link
 * always belongs to a verified person, so a signed-in unverified person's dead
 * link expired or was replaced by a newer one.
 */

export type VerifyAttempt = "ok" | "invalid" | "rate_limited" | "server" | "network";
export type AccountState = "verified" | "unverified" | "signed_out" | "unknown";

export type VerifyView = {
  /** True only when this link just verified the email. */
  verified: boolean;
  title: string;
  message: string;
  /** Where the page's link goes: never the login form for a signed-in person. */
  next: { href: string; label: string };
  /** A "Send a new link" button (signed in, not verified). */
  offerResend: boolean;
  /** A "Try again" button (the link was not used up). */
  offerRetry: boolean;
};

export async function attemptVerify(fetchImpl: typeof fetch, token: string): Promise<VerifyAttempt> {
  if (!token) return "invalid";
  try {
    const response = await fetchImpl("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return "ok";
    if (response.status === 429) return "rate_limited";
    if (response.status >= 500) return "server";
    return "invalid";
  } catch {
    return "network";
  }
}

export async function readAccountState(fetchImpl: typeof fetch): Promise<AccountState> {
  try {
    const response = await fetchImpl("/api/auth/account-status");
    if (response.status === 401) return "signed_out";
    if (!response.ok) return "unknown";
    const data = (await response.json()) as { emailVerified?: unknown };
    return data.emailVerified === true ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}

const CONTINUE = { href: "/", label: "Continue to Vibe Socials" };
const LOG_IN = { href: "/login", label: "Log in" };

export function verifyView(attempt: VerifyAttempt, account: AccountState): VerifyView {
  const signedIn = account === "verified" || account === "unverified";
  const next = account === "signed_out" ? LOG_IN : CONTINUE;
  const base = { verified: false, next, offerResend: false, offerRetry: false };

  if (attempt === "ok") {
    return { ...base, verified: true, next: CONTINUE, title: "Email verified", message: "Email verified. You're all set." };
  }
  if (attempt === "network") {
    return {
      ...base,
      offerRetry: true,
      title: "We couldn't reach Vibe Socials",
      message:
        "Your email isn't verified yet, and this link still works. Check your internet connection, then press Try again.",
    };
  }
  if (attempt === "rate_limited") {
    return {
      ...base,
      title: "Too many tries",
      message:
        "This network has tried too many links in the last few minutes, so this one wasn't checked. Wait 15 minutes, then reload this page.",
    };
  }
  if (attempt === "server") {
    return {
      ...base,
      offerRetry: true,
      title: "Something went wrong on our side",
      message: "Your email isn't verified yet, and this link still works. Please try again in a minute.",
    };
  }
  // A dead link.
  if (account === "verified") {
    return {
      ...base,
      title: "Your email is already verified",
      message: "This link was already used, and your email address is verified. There is nothing else to do.",
    };
  }
  if (signedIn) {
    return {
      ...base,
      offerResend: true,
      title: "This link has expired",
      message:
        "Each link works for 7 days, and a new email replaces the link before it. Press Send a new link, then use the button in the newest email.",
    };
  }
  return {
    ...base,
    title: "This link isn't valid",
    message:
      "This link has expired or was already used. If you verified your email before, there is nothing to do. Otherwise log in and press Resend email at the top of the page to get a new link.",
  };
}

export async function resendVerificationEmail(
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetchImpl("/api/auth/resend-verification", { method: "POST" });
    if (response.ok) {
      return { ok: true, message: "We sent a new link. Open the newest email from Vibe Socials and press its button." };
    }
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      message: data?.error ?? "We couldn't send the verification email just now. Please try again in a few minutes.",
    };
  } catch {
    return {
      ok: false,
      message: "We couldn't reach Vibe Socials, so no email was sent. Check your internet connection and try again.",
    };
  }
}
