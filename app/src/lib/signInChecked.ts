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

/** The csrf token when the providers list and the token both come back, else null. */
async function readyCsrfToken(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    if (!(await readJson("/api/auth/providers", fetchImpl))) return null;
    const csrf = await readJson("/api/auth/csrf", fetchImpl);
    return typeof csrf?.csrfToken === "string" && csrf.csrfToken !== "" ? csrf.csrfToken : null;
  } catch {
    return null;
  }
}

/** True when the providers list and a csrf token both come back, so signIn's own reads should too. */
export async function signInReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return (await readyCsrfToken(fetchImpl)) !== null;
}

type CredentialsSignIn = (
  provider: "credentials",
  options: { redirect: false; email: string; password: string },
) => Promise<unknown>;

/** next-auth's answer to a refused csrf token: the sign-in page with ?csrf=true. */
function saysCsrf(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url, "http://localhost").searchParams.get("csrf") === "true";
  } catch {
    return false;
  }
}

/** next-auth's answer to a sign-in that failed to start: its url carries ?error=. */
function saysError(url: string): boolean {
  try {
    return new URL(url, "http://localhost").searchParams.has("error");
  } catch {
    return true;
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

/** Leaves the page, as next-auth's signIn does (a #fragment needs the reload). */
function leaveFor(url: string): void {
  window.location.href = url;
  if (url.includes("#")) window.location.reload();
}

/**
 * Continue with Google. R31 lead review: next-auth's signIn reads the csrf
 * token a second time, and when that read fails the server's ?csrf=true
 * answer becomes /login?callbackUrl=... with no sign of it (pages.signIn,
 * core/index.js). So this makes signIn's own request itself, with the token
 * just read: POST /api/auth/signin/google, form-encoded { callbackUrl,
 * csrfToken, json: true } (react/index.js), and leaves for the answer's url
 * only when it has no csrf=true and no error. Anything else: nothing reached
 * Google, and the page stays.
 */
export async function googleSignInChecked(
  callbackUrl: string,
  fetchImpl: typeof fetch = fetch,
  navigate: (url: string) => void = leaveFor,
): Promise<{ ok: true } | { ok: false; reason: "not_sent" }> {
  const csrfToken = await readyCsrfToken(fetchImpl);
  if (!csrfToken) return { ok: false, reason: "not_sent" };
  let url: unknown;
  try {
    const response = await fetchOrNoAnswer(
      "/api/auth/signin/google",
      {
        method: "post",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ callbackUrl, csrfToken, json: "true" }),
      },
      fetchImpl,
    );
    if (!response.ok) return { ok: false, reason: "not_sent" };
    const data: unknown = await response.json().catch(() => null);
    url = typeof data === "object" && data !== null ? (data as { url?: unknown }).url : undefined;
  } catch {
    return { ok: false, reason: "not_sent" };
  }
  if (typeof url !== "string" || url === "" || saysCsrf(url) || saysError(url)) return { ok: false, reason: "not_sent" };
  navigate(url);
  return { ok: true };
}
