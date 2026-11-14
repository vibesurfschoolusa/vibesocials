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
  ) {
    super(message);
    this.name = "ReviewsApiError";
  }
}

/** The error a failed response stands for: its own sentence, else `fallback`. */
export async function readApiError(response: Response, fallback: string): Promise<ReviewsApiError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; reconnect?: unknown } | null;
  const message = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : fallback;
  return new ReviewsApiError(message, body?.reconnect === true);
}

/** The sentence to show for anything caught: a route's sentence, never a parse or network error's text. */
export function shownError(error: unknown, fallback: string): { message: string; settingsLink: boolean } {
  return error instanceof ReviewsApiError
    ? { message: error.message, settingsLink: error.settingsLink }
    : { message: fallback, settingsLink: false };
}
