import type { PostJobStatus } from "@prisma/client";

import type { PostJobDTO } from "@/lib/postsDto";

/**
 * R2-client-journey M1: a "Feed and Story" post is two Queue cards (F6). Owner
 * actions on one card used to act on that half alone while the dialog said
 * "It won't be published", so the Story still went out. The cancel and delete
 * dialogs now name the other half and its time and offer to include it
 * (checked by default); rejecting a held pair rejects both (the approval
 * route); rescheduling one half says the other keeps its time.
 */

/** The other half, as GET /api/posts/[id]/cancel describes it. */
export type PairInfo = {
  id: string;
  /** What the other half is: this feed post's Story, or this Story's feed post. */
  kind: "story" | "feed";
  status: PostJobStatus;
  scheduledFor: string | null;
};

type PairCard = Pick<PostJobDTO, "storyOf" | "alsoAsStory">;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Either half of a Feed and Story post whose other half is live. */
export function isPairCard(job: PairCard): boolean {
  return Boolean(job.storyOf || job.alsoAsStory);
}

function halfName(kind: PairInfo["kind"]): string {
  return kind === "story" ? "the Story" : "the feed post";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "This post also goes out as a Story, set for <time>." or the Story's version. */
function pairLine(pair: PairInfo): string {
  const time = pair.scheduledFor ? formatTimestamp(pair.scheduledFor) : null;
  if (pair.kind === "story") {
    return time ? `This post also goes out as a Story, set for ${time}.` : "This post also goes out as a Story, with no time set.";
  }
  return time ? `This is the Story of a feed post set for ${time}.` : "This is the Story of a feed post with no time set.";
}

/**
 * What the dialog says about the other half: always the line naming it; the
 * checkbox label only when it can be included (cancel: scheduled or draft;
 * delete: a draft), and the line shown when the box is cleared. Null with no
 * live other half.
 */
export function pairOption(
  pair: PairInfo | null,
  action: "cancel" | "delete",
): { line: string; label: string | null; keptLine: string | null } | null {
  if (!pair) return null;
  const name = halfName(pair.kind);
  const kept = `${capitalized(name)} is kept and keeps its time.`;
  if (action === "cancel") {
    if (pair.status === "scheduled" || pair.status === "draft") {
      return { line: pairLine(pair), label: `Also cancel ${name}`, keptLine: kept };
    }
    return {
      line: `${pairLine(pair)} It has already started publishing, so it is not changed.`,
      label: null,
      keptLine: null,
    };
  }
  if (pair.status === "draft") {
    return { line: pairLine(pair), label: `Also delete ${name}`, keptLine: `${capitalized(name)} is kept.` };
  }
  if (pair.status === "scheduled") {
    return {
      line: `${pairLine(pair)} It is scheduled, so it is not deleted; cancel it on its own card first.`,
      label: null,
      keptLine: null,
    };
  }
  return { line: `${pairLine(pair)} It is not changed.`, label: null, keptLine: null };
}

/** The toast after a cancel that asked to include the other half, from the answer's `pair`. */
export function pairCancelMessage(result: unknown, kind: PairInfo["kind"]): string {
  if (result === "cancelled") {
    return kind === "story" ? "Post and its Story cancelled." : "Story and its feed post cancelled.";
  }
  if (result === "not_cancelable") {
    return `Post cancelled. Its ${kind === "story" ? "Story" : "feed post"} had already started publishing or changed, so it was not cancelled.`;
  }
  return "Scheduled post cancelled.";
}

/** The toast when the draft went but its other half's delete was refused. */
export function pairDeleteFailedMessage(kind: PairInfo["kind"], error: string): string {
  return `The draft was deleted, but its ${kind === "story" ? "Story" : "feed post"} was not: ${error}`;
}

/** Added to the reject toast when the approval route rejected the other half too. */
export function pairRejectedNote(job: PairCard): string {
  if (job.alsoAsStory) return " Its Story was rejected too.";
  if (job.storyOf) return " Its feed post was rejected too.";
  return "";
}

/** The line when one half's time changes: the other half does not move with it. */
export function pairRescheduleNote(job: PairCard): string | null {
  if (job.alsoAsStory) return "Its Story keeps its own time. Change it on the Story's card if it should move too.";
  if (job.storyOf) return "The feed post keeps its own time. Change it on its card if it should move too.";
  return null;
}
