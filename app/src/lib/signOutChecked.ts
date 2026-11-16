import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { rereadSessionHere } from "@/lib/staleSignOut";

// A plain module (not "use client"), like signInChecked.ts: the account menu,
// Log in's notice and Settings all call it.

/** Lead review 3 (R28 NN2): no answer came, so the sign-out may have ended the session. */
export const SIGN_OUT_FAILED_MESSAGE = answerLostText("you may be signed out", "Then reload the page to see.");
/** R32 lead review: an answer came and the person is still signed in (csrf=true, a refusal, a session still there). */
export const SIGN_OUT_STILL_SIGNED_IN_MESSAGE = "You're still signed in. Press Sign out again.";

export type SignOutCheck = { ok: true } | { ok: false; message: string };

const LOST: SignOutCheck = { ok: false, message: SIGN_OUT_FAILED_MESSAGE };
const STILL_SIGNED_IN: SignOutCheck = { ok: false, message: SIGN_OUT_STILL_SIGNED_IN_MESSAGE };

/** A 2xx answer's JSON object, or null when it can't be read. */
async function jsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const data: unknown = await response.json().catch(() => null);
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/** next-auth's answer to a refused csrf token: its url carries ?csrf=true. */
function saysCsrf(url: string): boolean {
  try {
    return new URL(url, "http://localhost").searchParams.get("csrf") === "true";
  } catch {
    return true;
  }
}

/**
 * What next-auth's signOut does after its request: tell the other tabs
 * (client/_utils.js BroadcastChannel writes "nextauth.message" to
 * localStorage) and re-read this tab's session, so its context turns signed out.
 */
function tellTabsSignedOut(): void {
  try {
    localStorage.setItem(
      "nextauth.message",
      JSON.stringify({ event: "session", data: { trigger: "signout" }, timestamp: Math.floor(Date.now() / 1000) }),
    );
  } catch {
    // Storage blocked: the other tabs find out on their next session read.
  }
  rereadSessionHere();
}

/**
 * R32 new-customer L2: the one rule for whether a sign-out happened. next-auth
 * 4.24.15's signOut reads its csrf token with getCsrfToken (undefined on any
 * unreadable answer) and posts anyway; the server keeps the cookie and answers
 * 200 { url: ".../api/auth/signout?csrf=true" }, which signOut either returns
 * as if done or leaves for (next-auth's own "Are you sure?" page). So this
 * reads the token itself, sends signOut's request (POST /api/auth/signout,
 * form-encoded { csrfToken, callbackUrl, json: true }, react/index.js), and
 * counts it done only when the answer has no csrf=true and a session read then
 * names nobody. Never throws and never leaves the page: the caller shows the
 * failure's message and leaves only after { ok: true }.
 *
 * R32 lead review: two failure sentences. No answer at some step (offline, a
 * non-JSON 5xx, fetchOrNoAnswer's NoAnswerError), or an answer after the
 * request that can't be read, may have ended the session: SIGN_OUT_FAILED_MESSAGE.
 * An answer that leaves the person signed in (no token, a refusal, csrf=true,
 * a session that names someone): SIGN_OUT_STILL_SIGNED_IN_MESSAGE.
 */
export async function signOutChecked(
  fetchImpl: typeof fetch = fetch,
  afterSignedOut: () => void = tellTabsSignedOut,
): Promise<SignOutCheck> {
  try {
    const csrfAnswer = await fetchOrNoAnswer("/api/auth/csrf", { cache: "no-store" }, fetchImpl);
    const csrf = csrfAnswer.ok ? await jsonObject(csrfAnswer) : null;
    const csrfToken = typeof csrf?.csrfToken === "string" ? csrf.csrfToken : "";
    // Nothing was sent, so the session is as it was.
    if (!csrfToken) return STILL_SIGNED_IN;
    const response = await fetchOrNoAnswer(
      "/api/auth/signout",
      {
        method: "post",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken, callbackUrl: "/", json: "true" }),
      },
      fetchImpl,
    );
    if (!response.ok) return STILL_SIGNED_IN;
    const data = await jsonObject(response);
    // A 2xx we can't read may have cleared the cookie.
    if (data === null) return LOST;
    if (typeof data.url !== "string" || saysCsrf(data.url)) return STILL_SIGNED_IN;
    const sessionAnswer = await fetchOrNoAnswer("/api/auth/session", { cache: "no-store" }, fetchImpl);
    // An empty session is `{}`; a non-2xx or unreadable one says nothing about the cookie.
    const session = sessionAnswer.ok ? await jsonObject(sessionAnswer) : null;
    if (session === null) return LOST;
    if (typeof session.user === "object" && session.user !== null) return STILL_SIGNED_IN;
  } catch {
    return LOST;
  }
  afterSignedOut();
  return { ok: true };
}
