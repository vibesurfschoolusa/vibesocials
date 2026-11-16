import { readApiError, shownError, type ShownError } from "./api-error";
import type { GoogleReview } from "./types";

// F7 (R1 M5): the plain sentence for a failure the route did not explain.
export const REVIEWS_FAILED = "Couldn't load your Google reviews. Try again in a minute.";

export type ReviewsOutcome = { reviews: GoogleReview[]; truncated: boolean } | { error: ShownError };

/**
 * R27 client-journey L1: each call starts a request and returns whether it is
 * still the latest, so an answer for a location no longer selected is dropped.
 */
export function latestRequests(): () => () => boolean {
  let latest = 0;
  return () => {
    const id = ++latest;
    return () => id === latest;
  };
}

/** Loads a location's reviews and hands `show` the outcome, only while `isCurrent()`. */
export async function loadReviewsFor(
  location: string,
  isCurrent: () => boolean,
  show: (outcome: ReviewsOutcome) => void,
): Promise<void> {
  let outcome: ReviewsOutcome;
  try {
    const response = await fetch(`/api/reviews?location=${encodeURIComponent(location)}`);
    if (!response.ok) throw await readApiError(response, REVIEWS_FAILED);
    const data = await response.json();
    outcome = { reviews: data.reviews || [], truncated: data.truncated === true };
  } catch (err: unknown) {
    if (isCurrent()) console.error("Error fetching reviews:", err);
    outcome = { error: shownError(err, REVIEWS_FAILED) };
  }
  if (isCurrent()) show(outcome);
}
