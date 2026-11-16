import { safeGbpSignInUrl } from "@/lib/gbpSignIn";

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
    /** JJ3 lead review: an owner's in-place Google sign-in (lib/gbpSignIn.ts), when the route gave one. */
    readonly signInUrl?: string,
  ) {
    super(message);
    this.name = "ReviewsApiError";
  }
}

/** The error a failed response stands for: its own sentence, else `fallback`. */
export async function readApiError(response: Response, fallback: string): Promise<ReviewsApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown; reconnect?: unknown; signInUrl?: unknown }
    | null;
  const message = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : fallback;
  return new ReviewsApiError(message, body?.reconnect === true, safeGbpSignInUrl(body?.signInUrl) ?? undefined);
}

/** The sentence to show for anything caught: a route's sentence, never a parse or network error's text. */
export interface ShownError {
  message: string;
  settingsLink: boolean;
  signInUrl?: string;
}

export function shownError(error: unknown, fallback: string): ShownError {
  if (!(error instanceof ReviewsApiError)) return { message: fallback, settingsLink: false };
  return error.signInUrl
    ? { message: error.message, settingsLink: error.settingsLink, signInUrl: error.signInUrl }
    : { message: error.message, settingsLink: error.settingsLink };
}
