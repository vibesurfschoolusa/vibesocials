import type { signIn as nextAuthSignIn } from "next-auth/react";

import { answerLostText } from "@/lib/answerLost";
import { credentialsSignInChecked } from "@/lib/signInChecked";

export const LOGIN_FAILED_MESSAGE = "Invalid email or password.";
/** Lead review 3 (R28 NN2): the sign-in may have set the session before the answer was lost. */
export const LOGIN_UNREACHABLE_MESSAGE = answerLostText("you may be signed in", "Then reload the page to see.");

/** R30, R31: the providers list or csrf token didn't come back, so the sign-in press sent nothing. */
export const LOGIN_NOT_SENT_MESSAGE =
  "Vibe Socials couldn't be reached, so your email and password weren't sent. If your connection dropped, reconnect first, then press Sign in again.";
export const GOOGLE_NOT_SENT_MESSAGE =
  "Vibe Socials couldn't be reached, so nothing was sent. If your connection dropped, reconnect first, then press Continue with Google again.";
/**
 * Register's automatic sign-in after its 201, when the providers list didn't
 * come back. The 201 also comes for an email that already had an account, so
 * it claims no new one.
 */
export const REGISTER_SIGN_IN_UNFINISHED_MESSAGE = "Signing you in didn't finish. Log in with your email and password.";

/** R31 (new-customer L4): an answer came, but nobody is signed in (e.g. ?csrf=true). */
export const LOGIN_UNFINISHED_MESSAGE = "Signing you in didn't finish, so you aren't signed in. Press Sign in again.";
/** R31 (new-customer L1): Register's automatic sign-in was sent and its answer lost. */
export const REGISTER_SIGN_IN_LOST_MESSAGE = answerLostText(
  "you may be signed in",
  "Reload the page to see, or log in with your email and password.",
);

type SignIn = (
  provider: "credentials",
  options: { redirect: false; email: string; password: string },
) => ReturnType<typeof nextAuthSignIn> | Promise<unknown>;

/**
 * The login form's password sign-in (F7, R1 L7), counted by signInChecked's
 * rule (R31): a throw after the press is a lost answer; a refused or empty
 * answer is the wrong email or password; an answer with nobody signed in says so.
 */
export async function signInWithPassword(
  signIn: SignIn,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const check = await credentialsSignInChecked(signIn, email, password, fetchImpl);
  if (check.ok) return { ok: true };
  const error = {
    not_sent: LOGIN_NOT_SENT_MESSAGE,
    refused: LOGIN_FAILED_MESSAGE,
    unfinished: LOGIN_UNFINISHED_MESSAGE,
    lost: LOGIN_UNREACHABLE_MESSAGE,
  }[check.reason];
  return { ok: false, error };
}

/**
 * Register's automatic sign-in after its 201. Only a refusal goes to Log in
 * (the email may have had an account with another password); a throw stays on
 * the form (R31 L1: a page change offline is the browser's error page).
 */
export async function signInAfterRegister(
  signIn: SignIn,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; toLogin: true } | { ok: false; error: string }> {
  const check = await credentialsSignInChecked(signIn, email, password, fetchImpl);
  if (check.ok) return { ok: true };
  if (check.reason === "refused") return { ok: false, toLogin: true };
  return { ok: false, error: check.reason === "lost" ? REGISTER_SIGN_IN_LOST_MESSAGE : REGISTER_SIGN_IN_UNFINISHED_MESSAGE };
}
