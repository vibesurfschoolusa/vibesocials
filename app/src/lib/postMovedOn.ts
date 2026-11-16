import type { PostJobStatus } from "@prisma/client";

/**
 * R30 publishing L1: what a Cancel or an Edit of a post that is no longer
 * scheduled or a draft says (the cancel and edit routes' 409). A Queue left
 * open still shows such a post as Scheduled once the scanner has claimed it,
 * so the sentence says what happened and where to look. Null while the post
 * is still scheduled or a draft (or unknown): the route keeps its own sentence.
 */
export function postMovedOnText(status: PostJobStatus | null | undefined, verb: "cancelled" | "edited"): string | null {
  switch (status) {
    case "pending":
    case "in_progress":
      return `This post has started publishing, so it can't be ${verb}. Check Activity to see how it goes.`;
    case "completed":
      return `This post has already gone out, so it can't be ${verb}. Check Activity to see it.`;
    case "failed":
      return `This post was already sent and failed, so it can't be ${verb}. Check Activity to see what happened.`;
    case "cancelled":
      return verb === "cancelled" ? "This post was already cancelled." : "This post was cancelled, so it can't be edited.";
    default:
      return null;
  }
}
