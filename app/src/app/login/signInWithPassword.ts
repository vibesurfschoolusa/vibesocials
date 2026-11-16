import type { signIn as nextAuthSignIn } from "next-auth/react";

import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { beforeSignIn } from "@/lib/staleSignOut";

export const LOGIN_FAILED_MESSAGE = "Invalid email or password.";
/** Lead review 3 (R28 NN2): the sign-in may have set the session before the answer was lost. */
export const LOGIN_UNREACHABLE_MESSAGE = answerLostText("you may be signed in", "Then reload the page to see.");

/** R30: the providers list didn't come back, so the sign-in press sent nothing. */
export const LOGIN_NOT_SENT_MESSAGE =
  "Vibe Socials couldn't be reached, so your email and password weren't sent. If your connection dropped, reconnect first, then press Sign in again.";
export const GOOGLE_NOT_SENT_MESSAGE =
  "Vibe Socials couldn't be reached, so nothing was sent. If your connection dropped, reconnect first, then press Continue with Google again.";
/** Register's automatic sign-in after its 201, when the providers list didn't come back. */
export const REGISTER_SIGN_IN_UNFINISHED_MESSAGE =
  "Your account was created, but signing you in didn't finish. Log in with your email and password.";

/**
 * R30 new-customer L2: next-auth's signIn reads /api/auth/providers first and,
 * when that fails, sends the browser to /api/auth/error instead of throwing
 * (offline: the browser's own error page; a gateway 5xx: /login?error=undefined,
 * with what was typed gone). Each sign-in reads it first through
 * fetchOrNoAnswer and, when it doesn't come back, keeps the page and says so.
 */
export async function signInReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchOrNoAnswer("/api/auth/providers", { cache: "no-store" }, fetchImpl);
    if (!response.ok) return false;
    const data: unknown = await response.json().catch(() => null);
    return typeof data === "object" && data !== null;
  } catch {
    return false;
  }
}

type SignIn = (
  provider: "credentials",
  options: { redirect: false; email: string; password: string },
) => ReturnType<typeof nextAuthSignIn> | Promise<unknown>;

/**
 * The login form's password sign-in (F7, R1 L7): a call that throws (offline,
 * the server down) ends with a plain sentence instead of a spinner that never
 * stops; a refused or empty answer is the wrong email or password.
 */
export async function signInWithPassword(
  signIn: SignIn,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await signInReachable(fetchImpl))) return { ok: false, error: LOGIN_NOT_SENT_MESSAGE };
  try {
    // EE1 review: waits for a stale sign-out this page already sent, so it can't clear the new cookie.
    const result = (await beforeSignIn(() => signIn("credentials", { redirect: false, email, password }))) as
      | { ok?: boolean }
      | undefined
      | null;
    return result?.ok ? { ok: true } : { ok: false, error: LOGIN_FAILED_MESSAGE };
  } catch {
    return { ok: false, error: LOGIN_UNREACHABLE_MESSAGE };
  }
}
