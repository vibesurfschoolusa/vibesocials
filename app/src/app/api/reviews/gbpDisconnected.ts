import { GBP_DISCONNECTED_MESSAGE } from "@/app/api/connections/google_business_profile/gbpLocations";
import type { ReviewsReader } from "@/server/googleReviews";

/** A member can't connect Google: the owner's step, then the reload that shows it. */
export const GBP_DISCONNECTED_MEMBER_MESSAGE =
  "Google Business Profile was disconnected from this workspace. The workspace owner can connect it again; then reload this page.";

/**
 * Lead review: a reload throws away a typed reply, so the reply route's
 * sentences say to copy it first.
 */
const GBP_DISCONNECTED_REPLY_MESSAGE =
  "Google Business Profile was disconnected, maybe in another tab. Copy your reply, then reload this page and connect it again.";
const GBP_DISCONNECTED_REPLY_MEMBER_MESSAGE =
  "Google Business Profile was disconnected from this workspace. Copy your reply. The workspace owner can connect Google Business Profile again; then reload this page.";

/**
 * R28 client-journey L3: the Business Profile connection was removed while
 * Reviews was open (a 404 the page shows as it is, with no Retry). After a
 * reload the page shows its own Connect step (ReviewsEmptyState); the
 * owner's list sentence is the one the Settings picker routes give.
 * `reply`: the answer to a reply, whose typed text a reload would lose.
 */
export function gbpDisconnectedBody(role: ReviewsReader, { reply = false }: { reply?: boolean } = {}): { error: string } {
  if (reply) return { error: role === "member" ? GBP_DISCONNECTED_REPLY_MEMBER_MESSAGE : GBP_DISCONNECTED_REPLY_MESSAGE };
  return { error: role === "member" ? GBP_DISCONNECTED_MEMBER_MESSAGE : GBP_DISCONNECTED_MESSAGE };
}
