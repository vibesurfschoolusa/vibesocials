import { locationLabels } from "./location-labels";
import type { Location } from "./types";

/**
 * The heading's subtitle: how many reviews wait, or the general line while
 * they load. A listing with no reviews at all has nothing "with a reply".
 */
export function reviewsSubtitle(waiting: number | null, total: number): string {
  if (waiting === null) return "Manage and reply to your Google Business Profile reviews";
  if (total === 0) return "No reviews yet";
  if (waiting === 0) return "Every review has a reply";
  return waiting === 1 ? "1 review needs a reply" : `${waiting} reviews need a reply`;
}

/**
 * F7 (R1 M4): the line under the subtitle when Google had more reviews than
 * GET /api/reviews loads (REVIEWS_SHOWN_MAX in server/googleReviews.ts, 500;
 * not imported: that module is server-only). The counts above it are of these.
 */
export function reviewsCapNote(truncated: boolean): string | null {
  return truncated ? "Showing the latest 500 reviews." : null;
}

/** The Needs reply tab's empty title: nothing waits, or nothing has arrived yet. */
export function needsReplyEmptyTitle(total: number): string {
  return total === 0 ? "No reviews yet." : "Every review has a reply.";
}

/**
 * Which waiting review gets keyboard focus once `answeredId` is answered:
 * the next one in `waitingIds` (the list before it leaves), the previous one
 * when it was last, none when the list empties (focus then goes to the heading).
 */
export function focusAfterReply(waitingIds: string[], answeredId: string): string | null {
  const index = waitingIds.indexOf(answeredId);
  if (index === -1) return null;
  return waitingIds[index + 1] ?? waitingIds[index - 1] ?? null;
}

/** A picker with one choice only gets in the way. */
export function showLocationPicker(locations: Location[]): boolean {
  return locations.length > 1;
}

/** With exactly one location, its name (as the picker would read it); else none. */
export function singleLocationName(locations: Location[]): string | null {
  if (locations.length !== 1) return null;
  return locationLabels(locations).get(locations[0].name) ?? null;
}

/** The id of a review's "Reply to review" button, so focus can move to it after a reply posts. */
export function replyButtonId(reviewId: string): string {
  return `reply-to-${reviewId}`;
}
