import type { signIn as nextAuthSignIn } from "next-auth/react";

import { beforeSignIn } from "@/lib/staleSignOut";

export const LOGIN_FAILED_MESSAGE = "Invalid email or password.";
export const LOGIN_UNREACHABLE_MESSAGE =
  "We couldn't reach Vibe Socials. Check your internet connection and try again.";

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
): Promise<{ ok: true } | { ok: false; error: string }> {
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
