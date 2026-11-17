import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer, isNoConnection } from "@/lib/requestNoAnswer";
import { rereadSessionHere } from "@/lib/staleSignOut";

// A plain module (not "use client"), like signInChecked.ts: the account menu,
// Log in's notice and Settings all call it.

/** Lead review 3 (R28 NN2): no answer came, so the sign-out may have ended the session. */
export const SIGN_OUT_FAILED_MESSAGE = answerLostText("you may be signed out", "Then reload the page to see.");
/** R32 lead review: an answer came and the person is still signed in (csrf=true, a refusal, a session still there). */
export const SIGN_OUT_STILL_SIGNED_IN_MESSAGE = "You're still signed in. Press Sign out again.";

/** R33 pages L4: the token read got no answer, so the sign-out was never sent. */
export const SIGN_OUT_NOT_SENT_MESSAGE =
  "Vibe Socials couldn't be reached, so nothing was sent. If your connection dropped, reconnect first, then press Sign out again.";
/** R34 pages L2: the token read got an unreadable 5xx over a working connection; nothing was sent. */
export const SIGN_OUT_SERVER_PROBLEM_MESSAGE =
  "Vibe Socials had a problem, so nothing was sent. Press Sign out again in a minute.";

/**
 * R33 (cure 3): how a sign-out failed. Each caller words it for its own
 * screen: Change password has no Sign out button, and its server already
 * ended the session.
 * - not_sent: the token read got no answer (offline, the connection dropped); nothing was sent.
 * - server_problem: the token read got an unreadable 5xx (R34 pages L2); nothing was sent.
 * - refused: an answer came and the person is still signed in.
 * - lost: the sign-out was sent and its answer lost or unreadable; it may have worked.
 */
export type SignOutFailure = "not_sent" | "server_problem" | "refused" | "lost";
export type SignOutCheck = { ok: true } | { ok: false; kind: SignOutFailure };

/** The sentence for a screen with its own Sign out button (the account menu, Log in's notice). */
export function signOutButtonFailureText(kind: SignOutFailure): string {
  return {
    not_sent: SIGN_OUT_NOT_SENT_MESSAGE,
    server_problem: SIGN_OUT_SERVER_PROBLEM_MESSAGE,
    refused: SIGN_OUT_STILL_SIGNED_IN_MESSAGE,
    lost: SIGN_OUT_FAILED_MESSAGE,
  }[kind];
}

const LOST: SignOutCheck = { ok: false, kind: "lost" };
const STILL_SIGNED_IN: SignOutCheck = { ok: false, kind: "refused" };
const NOT_SENT: SignOutCheck = { ok: false, kind: "not_sent" };
const SERVER_PROBLEM: SignOutCheck = { ok: false, kind: "server_problem" };

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
 * R32 lead review, R33 pages L4: three failures. No answer after the sign-out
 * was sent (offline, a non-JSON 5xx, fetchOrNoAnswer's NoAnswerError), or an
 * answer to it that can't be read, may have ended the session: "lost". No
 * answer to the token read means nothing was sent: "not_sent" when the
 * connection gave none, "server_problem" for an unreadable 5xx. An answer that
 * leaves the person signed in is "refused": a token read with no token in it,
 * a refusal, csrf=true, a session that names someone.
 */
export async function signOutChecked(
  fetchImpl: typeof fetch = fetch,
  afterSignedOut: () => void = tellTabsSignedOut,
): Promise<SignOutCheck> {
  let csrfToken = "";
  try {
    const csrfAnswer = await fetchOrNoAnswer("/api/auth/csrf", { cache: "no-store" }, fetchImpl);
    const csrf = csrfAnswer.ok ? await jsonObject(csrfAnswer) : null;
    if (typeof csrf?.csrfToken === "string") csrfToken = csrf.csrfToken;
  } catch (error) {
    // No answer to the token read: the sign-out is never sent. Only a request
    // that got no answer at all is the connection's fault (R34 pages L2).
    return isNoConnection(error) ? NOT_SENT : SERVER_PROBLEM;
  }
  // An answer with no token: nothing was sent, so the session is as it was.
  if (!csrfToken) return STILL_SIGNED_IN;
  try {
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
