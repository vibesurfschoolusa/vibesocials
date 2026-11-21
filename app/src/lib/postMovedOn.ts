import type { PostJobStatus } from "@prisma/client";

/** What the press would have done, as the sentence's verb. */
export type MovedOnVerb =
  | "cancelled"
  | "edited"
  | "published"
  | "scheduled"
  | "approved or rejected"
  | "deleted"
  // R32 publishing L2: a member's Submit for approval.
  | "sent for approval";

/** R31 publishing L4: a post that is gone (deleted, or not in this workspace), never a bare "Not found". */
export const POST_GONE_TEXT = "This post no longer exists.";

/**
 * R31 publishing L5: a post the Queue still shows as Scheduled that went back
 * to a draft (the client asked for a change on the review link, or a member's
 * edit sent it back for approval), so it has no time to move.
 */
export const POST_NOW_DRAFT_TEXT = "This post is now a draft (a change was asked for, or it is waiting for approval).";

/** R60: a pinned write missed a post the action still fits; a page words it for where it is shown. */
export const POST_CHANGED_CODE = "POST_CHANGED";
export const POST_CHANGED_TEXT = "This post changed in the meantime. Try again.";

/**
 * R60 publishing-flow L1, L2 and pages-a L1: the one rule for a pinned write
 * that matched nothing (a lost race), decided from the post read again. If the
 * action still fits it (a draft or scheduled post the press could still act
 * on), something else changed it in the meantime: POST_CHANGED, so the press
 * can be tried again. Otherwise the post moved on: its moved-on sentence, with
 * the route's own code and, after it, the route's `after` line. Every route
 * whose write is pinned answers its lost race here (lostRace.guard.test.ts),
 * so the wording is not patched route by route again.
 */
export function lostRaceAnswer(
  reRead: { status: PostJobStatus } | null | undefined,
  verb: MovedOnVerb,
  movedOn: { code: string; after?: string },
): { error: string; code: string } {
  const said = postMovedOnText(reRead?.status ?? null, verb);
  if (said === null) return { error: POST_CHANGED_TEXT, code: POST_CHANGED_CODE };
  return { error: movedOn.after ? `${said} ${movedOn.after}` : said, code: movedOn.code };
}

/**
 * R30 publishing L1, R31 publishing L1-L6: the one rule for what a post action
 * says when the post moved on since the page was drawn: started publishing,
 * already published, failed, cancelled, gone (`null`: no such post in this
 * workspace), or (for a delete) scheduled now. The cancel, cancel-series,
 * publish, approval, PATCH and DELETE routes word their refusals here, and the
 * pages treat any such answer the same way (queueActions postActionRefusal).
 * Null while the post is in a state the action fits: the route keeps its own
 * sentence.
 *
 * A failed post may never have been sent (no connection, a paused workspace,
 * the daily limit, the stuck-job sweep), so "failed" says nothing about sending.
 */
export function postMovedOnText(status: PostJobStatus | null | undefined, verb: MovedOnVerb): string | null {
  switch (status) {
    case null:
    case undefined:
      return POST_GONE_TEXT;
    case "pending":
    case "in_progress":
      return `This post has started publishing, so it can't be ${verb}. Check Activity to see how it goes.`;
    case "completed":
      return `This post has already gone out, so it can't be ${verb}. Check Activity to see it.`;
    case "failed":
      return `This post failed, so it can't be ${verb}. Check Activity for what to do next.`;
    case "cancelled":
      return verb === "cancelled" ? "This post was already cancelled." : `This post was cancelled, so it can't be ${verb}.`;
    case "scheduled":
      // Lead review: a draft given a time in an Edit left open, that a teammate scheduled meanwhile.
      if (verb === "scheduled") return "This post is scheduled now (someone else scheduled it), so the new time wasn't saved.";
      return verb === "deleted" ? "This post is scheduled now, so it can't be deleted. Cancel it first, then delete it." : null;
    default:
      return null;
  }
}
