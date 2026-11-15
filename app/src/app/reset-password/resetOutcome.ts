/**
 * What the reset-password form says after it sends the new password
 * (R15-new-customer L2). Like verifyOutcome.ts, the form chooses by the
 * answer's status rather than showing the route's own text: the route answers
 * one uniform 400 for every dead link (no oracle), so a 400 is the invalid-link
 * state with "Request a new link"; a 429 says how long to wait; anything from
 * 500 up says the password wasn't changed.
 */

/** R5 pages L8: what the form says when the reset didn't go through. */
export const RESET_FAILED_MESSAGE = "Your password wasn't changed. Try again in a minute.";
export const RESET_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so your password wasn't changed. Check your internet connection and try again.";

/** The route's rate-limit window (api/auth/reset-password RATE_LIMIT), when the answer names no wait. */
const RATE_WINDOW_SECONDS = 15 * 60;

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
    response = await fetchImpl("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
  } catch {
    return { kind: "error", message: RESET_OFFLINE_MESSAGE };
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
