import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { beforeSignIn } from "@/lib/staleSignOut";

// A plain module (not "use client"): Log in's helper and the Register form
// and the Google button all call it (clientBoundary.guard.test.ts).

/**
 * R31 (new-customer L1, L2, L4): the one rule for whether a sign-in happened.
 * next-auth 4.24.15's signIn swallows failures in its own reads: no providers
 * list sends the browser to /api/auth/error; no csrf token (getCsrfToken
 * returns undefined for any unreadable answer) posts without one, and the
 * server answers a 200 whose url ends in ?csrf=true, which signIn returns as
 * { ok: true }. So both reads are made first, a sign-in counts only with a
 * clean answer and a session that names someone, and each page words the
 * reason in its own sentence.
 *
 * - not_sent: a read before the press failed; nothing typed was sent.
 * - refused: the server refused the email and password.
 * - unfinished: an answer came, but nobody is signed in.
 * - lost: the answer was lost after the sign-in was sent; it may have worked.
 */
export type SignInCheck = { ok: true } | { ok: false; reason: "not_sent" | "refused" | "unfinished" | "lost" };

async function readJson(path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  const response = await fetchOrNoAnswer(path, { cache: "no-store" }, fetchImpl);
  if (!response.ok) return null;
  const data: unknown = await response.json().catch(() => null);
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/** True when the providers list and a csrf token both come back, so signIn's own reads should too. */
export async function signInReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    if (!(await readJson("/api/auth/providers", fetchImpl))) return false;
    const csrf = await readJson("/api/auth/csrf", fetchImpl);
    return typeof csrf?.csrfToken === "string" && csrf.csrfToken !== "";
  } catch {
    return false;
  }
}

type CredentialsSignIn = (
  provider: "credentials",
  options: { redirect: false; email: string; password: string },
) => Promise<unknown>;

type GoogleSignIn = (provider: "google", options: { callbackUrl: string }) => Promise<unknown>;

/** next-auth's answer to a refused csrf token: the sign-in page with ?csrf=true. */
function saysCsrf(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url, "http://localhost").searchParams.get("csrf") === "true";
  } catch {
    return false;
  }
}

/** Password sign-in (Log in, and Register's automatic one), counted by the rule above. */
export async function credentialsSignInChecked(
  signIn: CredentialsSignIn,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInCheck> {
  if (!(await signInReachable(fetchImpl))) return { ok: false, reason: "not_sent" };
  let result: { ok?: unknown; error?: unknown; url?: unknown } | null | undefined;
  try {
    // EE1 review: waits for a stale sign-out this page already sent, so it can't clear the new cookie.
    result = (await beforeSignIn(() => signIn("credentials", { redirect: false, email, password }))) as typeof result;
  } catch {
    return { ok: false, reason: "lost" };
  }
  if (result?.ok !== true || result.error) return { ok: false, reason: "refused" };
  if (saysCsrf(result.url)) return { ok: false, reason: "unfinished" };
  try {
    const session = await readJson("/api/auth/session", fetchImpl);
    if (session === null) {
      // An empty session is `{}`; a non-2xx or unreadable one says nothing about the cookie.
      return { ok: false, reason: "lost" };
    }
    const user = session.user;
    return typeof user === "object" && user !== null ? { ok: true } : { ok: false, reason: "unfinished" };
  } catch {
    return { ok: false, reason: "lost" };
  }
}

/**
 * Continue with Google: signIn leaves the page for Google when it works. A
 * throw means its redirect request failed (offline, a gateway's 5xx page),
 * and nothing reached Google.
 */
export async function googleSignInChecked(
  signIn: GoogleSignIn,
  callbackUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: "not_sent" }> {
  if (!(await signInReachable(fetchImpl))) return { ok: false, reason: "not_sent" };
  try {
    await signIn("google", { callbackUrl });
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_sent" };
  }
}
