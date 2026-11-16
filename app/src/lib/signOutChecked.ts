import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { rereadSessionHere } from "@/lib/staleSignOut";

// A plain module (not "use client"), like signInChecked.ts: the account menu,
// Log in's notice and Settings all call it.

/** Lead review 3 (R28 NN2): the sign-out may have ended the session before the answer was lost. */
export const SIGN_OUT_FAILED_MESSAGE = answerLostText("you may be signed out", "Then reload the page to see.");

async function readJson(path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  const response = await fetchOrNoAnswer(path, { cache: "no-store" }, fetchImpl);
  if (!response.ok) return null;
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
 * names nobody. Never throws and never leaves the page: the caller words a
 * false with SIGN_OUT_FAILED_MESSAGE and leaves only after a true.
 */
export async function signOutChecked(
  fetchImpl: typeof fetch = fetch,
  afterSignedOut: () => void = tellTabsSignedOut,
): Promise<boolean> {
  try {
    const csrf = await readJson("/api/auth/csrf", fetchImpl);
    const csrfToken = typeof csrf?.csrfToken === "string" ? csrf.csrfToken : "";
    if (!csrfToken) return false;
    const response = await fetchOrNoAnswer(
      "/api/auth/signout",
      {
        method: "post",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken, callbackUrl: "/", json: "true" }),
      },
      fetchImpl,
    );
    if (!response.ok) return false;
    const data: unknown = await response.json().catch(() => null);
    const url = typeof data === "object" && data !== null ? (data as { url?: unknown }).url : undefined;
    if (typeof url !== "string" || saysCsrf(url)) return false;
    const session = await readJson("/api/auth/session", fetchImpl);
    // An empty session is `{}`; a non-2xx or unreadable one says nothing about the cookie.
    if (session === null || (typeof session.user === "object" && session.user !== null)) return false;
  } catch {
    return false;
  }
  afterSignedOut();
  return true;
}
