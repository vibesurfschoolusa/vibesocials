import type { PostJobStatus } from "@prisma/client";

/** What the press would have done, as the sentence's verb. */
export type MovedOnVerb = "cancelled" | "edited" | "published" | "scheduled" | "approved or rejected" | "deleted";

/** R31 publishing L4: a post that is gone (deleted, or not in this workspace), never a bare "Not found". */
export const POST_GONE_TEXT = "This post no longer exists.";

/**
 * R31 publishing L5: a post the Queue still shows as Scheduled that went back
 * to a draft (the client asked for a change on the review link, or a member's
 * edit sent it back for approval), so it has no time to move.
 */
export const POST_NOW_DRAFT_TEXT = "This post is now a draft (a change was asked for, or it is waiting for approval).";

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
      return verb === "deleted" ? "This post is scheduled now, so it can't be deleted. Cancel it first, then delete it." : null;
    default:
      return null;
  }
}
