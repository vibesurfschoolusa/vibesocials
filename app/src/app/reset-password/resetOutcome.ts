/**
 * What the reset-password form says after it sends the new password
 * (R15-new-customer L2). Like verifyOutcome.ts, the form chooses by the
 * answer's status rather than showing the route's own text: the route answers
 * one uniform 400 for every dead link (no oracle), so a 400 is the invalid-link
 * state with "Request a new link"; a 429 says how long to wait; the route's own
 * readable 500 (the transaction rolled back) says the password wasn't changed.
 * R29 OO1 (new-customer L1): an unreadable 5xx (a gateway's page) can come
 * after the commit; fetchOrNoAnswer throws it as no answer, so it says "may".
 */

import { answerLostText } from "@/lib/answerLost";
import { newPasswordProblem } from "@/lib/passwordRule";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

/** R5 pages L8: what the form says when the reset didn't go through. */
export const RESET_FAILED_MESSAGE = "Your password wasn't changed. Try again in a minute.";
/**
 * R28 NN2 (new-customer L2): the reset may have gone through before the
 * answer was lost; the link is then used up, so a retry shows the dead-link
 * card. Logging in with the new password tells.
 */
export const RESET_MAYBE_CHANGED_MESSAGE = answerLostText(
  "your password may have changed",
  "Then log in with your new password. If that doesn't work, request a new link: this one may be used up.",
);

/** The route's rate-limit window (api/auth/reset-password RATE_LIMIT), when the answer names no wait. */
const RATE_WINDOW_SECONDS = 15 * 60;

/**
 * The form's own checks before it sends. Every 400 from the route reads as a
 * dead link, so these must refuse whatever the route's password rule refuses.
 */
export function resetFormProblem(password: string, confirm: string): string | null {
  if (password !== confirm) return "Passwords don't match.";
  return newPasswordProblem(password);
}

export type ResetOutcome = { kind: "done" } | { kind: "invalid_link" } | { kind: "error"; message: string };

function waitSentence(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const wait = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `Too many tries from this network, so your password wasn't changed. Wait ${wait}, then try again.`;
}

async function retryAfterSeconds(response: Response): Promise<number> {
  const data = (await response.json().catch(() => null)) as { retryAfterSeconds?: unknown } | null;
  if (typeof data?.retryAfterSeconds === "number" && data.retryAfterSeconds > 0) return data.retryAfterSeconds;
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : RATE_WINDOW_SECONDS;
}

export async function submitReset(fetchImpl: typeof fetch, token: string, password: string): Promise<ResetOutcome> {
  let response: Response;
  try {
    response = await fetchOrNoAnswer(
      "/api/auth/reset-password",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) },
      fetchImpl,
    );
  } catch {
    return { kind: "error", message: RESET_MAYBE_CHANGED_MESSAGE };
  }
  if (response.ok) return { kind: "done" };
  if (response.status === 429) return { kind: "error", message: waitSentence(await retryAfterSeconds(response)) };
  if (response.status >= 500) return { kind: "error", message: RESET_FAILED_MESSAGE };
  // Every other refusal is the uniform dead-link 400: the form's own checks
  // already match the route's password rule.
  return { kind: "invalid_link" };
}

/**
 * R18 new-customer L1 (= security L1, pages L1): a reset ends every session on
 * the server (sessionVersion), but this browser's cached session would still
 * say signed in, and "Log in" would open the signed-in notice. So the browser
 * signs out here, as the new-email page does. A failed sign-out is ignored: the
 * password did change, and the success message must still show.
 */
export async function signOutAfterReset(
  outcome: ResetOutcome,
  signOutFn: (options: { redirect: false }) => Promise<unknown>,
): Promise<void> {
  if (outcome.kind !== "done") return;
  await signOutFn({ redirect: false }).catch(() => undefined);
}
