/**
 * What the verify-email page says after it tries the link (R5 new-customer
 * L3, pages L7). The verify route answers one uniform 400 for every dead
 * link (no oracle, api/auth/verify-email), so the page tells the cases apart
 * from what it can know itself: the answer's status and whether the request
 * got through at all. A dead link may be another account's, so the answer
 * about it stays about the link; the signed-in account's own state adds a new
 * link to an unverified one, and "already verified" for a verified one.
 */

import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { waitSecondsOf, waitText } from "@/lib/tooManyTriesText";

/** R28 NN2: the email may have gone before the answer was lost (this page and the banners). */
export const VERIFY_RESEND_MAYBE_SENT_MESSAGE = answerLostText(
  "a new link may have been sent",
  "Look in your inbox before you ask for another.",
);

export type VerifyAttempt = "ok" | "invalid" | "rate_limited" | "server" | "network";
/** A try's answer; a 429 names its wait (R48 pages-a L2), when the route sent one. */
export type VerifyAnswer = { attempt: VerifyAttempt; waitSeconds?: number };
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
  /** A "Try again" button: the link may not be used up, and a used one then says so. */
  offerRetry: boolean;
};

export async function attemptVerify(fetchImpl: typeof fetch, token: string): Promise<VerifyAnswer> {
  if (!token) return { attempt: "invalid" };
  try {
    const response = await fetchOrNoAnswer(
      "/api/auth/verify-email",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
      fetchImpl,
    );
    if (response.ok) return { attempt: "ok" };
    if (response.status === 429) {
      const data: unknown = await response.json().catch(() => null);
      const waitSeconds = waitSecondsOf(data, response.headers.get("Retry-After"));
      return waitSeconds === undefined ? { attempt: "rate_limited" } : { attempt: "rate_limited", waitSeconds };
    }
    if (response.status >= 500) return { attempt: "server" };
    return { attempt: "invalid" };
  } catch {
    return { attempt: "network" };
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

/**
 * R29 OO1 (pages L3): Try again shows a signed-out reader nothing about the
 * address (a used link gets the uniform 400), so they are told to log in.
 */
const SEE_WHETHER_VERIFIED = "log in to see whether your address is verified";

export function verifyView(
  attempt: VerifyAttempt,
  account: AccountState,
  { retried = false, waitSeconds }: { retried?: boolean; waitSeconds?: number } = {},
): VerifyView {
  const signedOut = account === "signed_out";
  const next = signedOut ? LOG_IN : CONTINUE;
  const base = { verified: false, next, offerResend: false, offerRetry: false };

  if (attempt === "ok") {
    return { ...base, verified: true, next: CONTINUE, title: "Email verified", message: "Email verified. You're all set." };
  }
  // R28 NN2: the link may have verified the email before the answer was lost.
  // Try again is safe: a used link then shows "already verified" when signed in.
  if (attempt === "network") {
    return {
      ...base,
      offerRetry: true,
      title: "Vibe Socials didn't answer",
      message: answerLostText(
        "your email may already be verified",
        signedOut ? `Then press Try again, or ${SEE_WHETHER_VERIFIED}.` : "Then press Try again to see.",
      ),
    };
  }
  if (attempt === "rate_limited") {
    return {
      ...base,
      title: "Too many tries",
      message:
        // R48 pages-a L2: the route's own wait; 15 minutes, its whole window, when it names none.
        `This network has tried too many links in the last few minutes, so this one wasn't checked. Wait ${waitSeconds === undefined ? "15 minutes" : waitText(waitSeconds)}, then reload this page.`,
    };
  }
  if (attempt === "server") {
    return {
      ...base,
      offerRetry: true,
      title: "Something went wrong on our side",
      message: signedOut
        ? `Your email may not be verified yet. Press Try again in a minute, or ${SEE_WHETHER_VERIFIED}.`
        : "Your email may not be verified yet. Press Try again in a minute to see.",
    };
  }
  // A dead link. It may belong to another account than the one signed in, so
  // the answer is about the link; a new link is offered only to a signed-in
  // account that itself still needs verifying. R6-new-customer L6: a
  // verified account is also told it has nothing left to do.
  if (account === "verified") {
    return {
      ...base,
      title: "Your email is already verified",
      message:
        "This link has expired or was already used, but the account you're signed in to is already verified, so there's nothing more to do. If the link is for another account, sign in to that account first.",
    };
  }
  // A signed-out retry: the first press may have used the link to verify.
  if (retried && signedOut) {
    return {
      ...base,
      title: "This link can't be used again",
      message: `This link has expired or was already used. It may have verified your email when you first pressed it: ${SEE_WHETHER_VERIFIED}.`,
    };
  }
  return {
    ...base,
    offerResend: account === "unverified",
    title: "This link isn't valid",
    message:
      "This link has expired or was already used. If you asked for a link more than once, open the newest email. If it is for another account, sign in to that account first.",
  };
}

export async function resendVerificationEmail(
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetchOrNoAnswer("/api/auth/resend-verification", { method: "POST" }, fetchImpl);
    if (response.ok) {
      return { ok: true, message: "We sent a new link. Open the newest email from Vibe Socials and press its button." };
    }
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      message: data?.error ?? "We couldn't send the verification email just now. Please try again in a few minutes.",
    };
  } catch {
    // R28 NN2: the email may have gone before the answer was lost.
    return {
      ok: false,
      message: VERIFY_RESEND_MAYBE_SENT_MESSAGE,
    };
  }
}
