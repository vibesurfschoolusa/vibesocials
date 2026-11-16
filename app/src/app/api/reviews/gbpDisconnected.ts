import { GBP_DISCONNECTED_MESSAGE } from "@/app/api/connections/google_business_profile/gbpLocations";
import type { ReviewsReader } from "@/server/googleReviews";

/** A member can't connect Google: the owner's step, then the reload that shows it. */
export const GBP_DISCONNECTED_MEMBER_MESSAGE =
  "Google Business Profile was disconnected from this workspace. The workspace owner can connect it again; then reload this page.";

/**
 * R28 client-journey L3: the Business Profile connection was removed while
 * Reviews was open (a 404 the page shows as it is, with no Retry). After a
 * reload the page shows its own Connect step (ReviewsEmptyState); the
 * owner's sentence is the one the Settings picker routes give.
 */
export function gbpDisconnectedBody(role: ReviewsReader): { error: string } {
  return { error: role === "member" ? GBP_DISCONNECTED_MEMBER_MESSAGE : GBP_DISCONNECTED_MESSAGE };
}
