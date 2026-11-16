import { gbpSignInUrl } from "@/lib/gbpSignIn";

/**
 * F7 (R1 M5): what the Reviews page shows when a call fails. The routes answer
 * `{ error, reconnect? }` (server/googleReviews.ts reviewsErrorBody), but a
 * proxy or a crash can answer with HTML or nothing, so the body is read
 * defensively and only a route's own sentence is ever shown.
 */
export class ReviewsApiError extends Error {
  constructor(
    message: string,
    readonly settingsLink: boolean,
    /** JJ3 lead review: the route asks an owner for the in-place Google sign-in (lib/gbpSignIn.ts). */
    readonly signIn = false,
    /** R25: false when asking again can't change the answer (a final status or code, readApiError). */
    readonly retry = true,
  ) {
    super(message);
    this.name = "ReviewsApiError";
  }
}

/**
 * R25 lead review: the reply route's codes for a failure a retry can't change
 * (server/googleReviews.ts REPLY_FINAL_CODES; this file is client code, so the
 * values are repeated, and a test keeps them equal).
 */
export const FINAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "RECONNECT_REQUIRED",
  "GBP_ACCESS_REFUSED",
  "GBP_LOCATION_GONE",
  "GBP_CHOOSE_LOCATION_AGAIN",
  "GBP_REVIEW_GONE",
]);

/** Statuses whose answer sending again can't change: a refused request, a missing review, a 403. */
const FINAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

/** The error a failed response stands for: its own sentence, else `fallback`. */
export async function readApiError(response: Response, fallback: string): Promise<ReviewsApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown; reconnect?: unknown; signIn?: unknown; code?: unknown }
    | null;
  const message = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : fallback;
  // Only the flag is read: a URL in an answer is never followed.
  // Only try-later (a 5xx with no final code, a 429) and no answer at all stay retryable.
  const final = FINAL_STATUSES.has(response.status) || (typeof body?.code === "string" && FINAL_FAILURE_CODES.has(body.code));
  return new ReviewsApiError(message, body?.reconnect === true, body?.signIn === true, !final);
}

/** The sentence to show for anything caught: a route's sentence, never a parse or network error's text. */
export interface ShownError {
  message: string;
  settingsLink: boolean;
  signIn?: true;
  /** Set (false) only when asking again can't change the answer. */
  retry?: false;
}

export function shownError(error: unknown, fallback: string): ShownError {
  if (!(error instanceof ReviewsApiError)) return { message: fallback, settingsLink: false };
  const shown: ShownError = { message: error.message, settingsLink: error.settingsLink };
  if (error.signIn) shown.signIn = true;
  if (!error.retry) shown.retry = false;
  return shown;
}

/** Whether the page offers Retry (or keeps a dialog open to send again) for this error. */
export function canRetry(shown: ShownError): boolean {
  return shown.retry !== false;
}

/**
 * The in-place Google sign-in for an error that asks for one, built from the
 * workspace the page was drawn for (JJ3 lead review), else undefined.
 */
export function signInHref(shown: ShownError, workspaceId: string): string | undefined {
  return shown.signIn ? gbpSignInUrl(workspaceId) : undefined;
}
