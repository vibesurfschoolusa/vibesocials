import { locationLabels } from "./location-labels";
import type { Location } from "./types";

/** The heading's subtitle: how many reviews wait, or the general line while they load. */
export function reviewsSubtitle(waiting: number | null): string {
  if (waiting === null) return "Manage and reply to your Google Business Profile reviews";
  if (waiting === 0) return "Every review has a reply";
  return waiting === 1 ? "1 review needs a reply" : `${waiting} reviews need a reply`;
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
