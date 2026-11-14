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

/** What happened to an other half that can no longer be changed; null while it is still a draft or scheduled. */
function finishedPhrase(status: PostJobStatus): string | null {
  switch (status) {
    case "pending":
    case "in_progress":
      return "has already started publishing";
    case "completed":
      return "was already published";
    case "failed":
      return "did not go out";
    default:
      return null;
  }
}

/** The line naming a draft or scheduled other half and its time (a passed time reads as past). */
function pairLine(pair: PairInfo, now: number): string {
  const time = pair.scheduledFor ? formatTimestamp(pair.scheduledFor) : null;
  const passed = pair.scheduledFor ? new Date(pair.scheduledFor).getTime() <= now : false;
  if (pair.kind === "story") {
    if (!time) return "This post also goes out as a Story, with no time set.";
    return passed
      ? `This post also has a Story, which was set for ${time}.`
      : `This post also goes out as a Story, set for ${time}.`;
  }
  if (!time) return "This is the Story of a feed post with no time set.";
  return passed ? `This is the Story of a feed post that was set for ${time}.` : `This is the Story of a feed post set for ${time}.`;
}

/**
 * What the dialog says about the other half: always the line naming it; the
 * checkbox label only when it can be included (cancel: scheduled or draft;
 * delete: a draft), and the line shown when the box is cleared. Null with no
 * live other half (a cancelled one is none: the lookup leaves it out).
 */
export function pairOption(
  pair: PairInfo | null,
  action: "cancel" | "delete",
  now: number = Date.now(),
): { line: string; label: string | null; keptLine: string | null } | null {
  if (!pair || pair.status === "cancelled") return null;
  const finished = finishedPhrase(pair.status);
  if (finished) {
    const line =
      pair.kind === "story"
        ? `This post's Story ${finished}, so it is not changed.`
        : `This is the Story of a feed post that ${finished}, so it is not changed.`;
    return { line, label: null, keptLine: null };
  }
  const name = halfName(pair.kind);
  if (action === "cancel") {
    return { line: pairLine(pair, now), label: `Also cancel ${name}`, keptLine: `${capitalized(name)} is kept and keeps its time.` };
  }
  if (pair.status === "draft") {
    return { line: pairLine(pair, now), label: `Also delete ${name}`, keptLine: `${capitalized(name)} is kept.` };
  }
  return {
    line: `${pairLine(pair, now)} It is scheduled, so it is not deleted; cancel it on its own card first.`,
    label: null,
    keptLine: null,
  };
}

/** The open dialog's lookup of the other half, as the Queue keeps it. */
export type PairLookup = { jobId: string; pair?: PairInfo | null; failed?: boolean };

/**
 * Where the dialog's lookup stands for this card: loading keeps Confirm
 * disabled (so nobody cancels one half before seeing the other); a failed
 * lookup lets Confirm act on this post alone and says so.
 */
export function pairLookupState(
  job: { id: string },
  lookup: PairLookup | null,
): { loading: boolean; failed: boolean; pair: PairInfo | null } {
  if (!lookup || lookup.jobId !== job.id) return { loading: false, failed: false, pair: null };
  if (lookup.failed) return { loading: false, failed: true, pair: null };
  if (lookup.pair === undefined) return { loading: true, failed: false, pair: null };
  return { loading: false, failed: false, pair: lookup.pair };
}

/** The dialog's line when the lookup failed. */
export function pairLookupFailedLine(job: PairCard, action: "cancel" | "delete"): string {
  const half = job.storyOf ? "a feed post half" : "a Story half";
  return `Couldn't check whether this post has ${half}. Only this post will be ${action === "cancel" ? "cancelled" : "deleted"}.`;
}

/** The toast when the other half's delete found it already gone. */
export function pairAlreadyDeletedMessage(kind: PairInfo["kind"]): string {
  return `The draft was deleted. Its ${kind === "story" ? "Story" : "feed post"} had already been deleted.`;
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
