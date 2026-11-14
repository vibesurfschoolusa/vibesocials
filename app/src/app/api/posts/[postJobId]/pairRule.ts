import type { Platform, PostJobStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { storyPlatformsOf } from "@/lib/storyPlacement";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import { buildPublishEvent, prepareDeferredPostJobDispatch } from "@/server/jobs/posting";

/**
 * R3-client-journey M1 (third finding of one cause, after R1 H1 and R2 M1): a
 * "Feed and Story" post is two jobs, the Story job naming its feed job in
 * storyOfPostJobId (F6; no foreign key). The Queue shows the pair as ONE card,
 * and every owner action on it must reach both halves. Each route used to
 * carry its own pair handling, and each new action forgot it, so the rule
 * lives here and every action uses it:
 *
 *  - the request asks for it with `includePair: true` (`wantsPair`); the
 *    Queue sends it for every Feed and Story card;
 *  - the other half is read in the caller's workspace (`readPairHalf`);
 *  - `applyToPair` runs the route's own pinned, conditional write on this
 *    post and then on the other half, in one transaction, so the second write
 *    has the same checks as the first. A half that already went out, is
 *    publishing, was cancelled, fails the route's own check, or changed in
 *    the meantime is left alone, and the answer's `pair` says so in a
 *    sentence the Queue shows as it is.
 *
 * Without `includePair` nothing here reads or writes anything extra, so a post
 * that is not a pair behaves exactly as before.
 */

export const PAIR_HALF_SELECT = {
  id: true,
  storyOfPostJobId: true,
  status: true,
  scheduledFor: true,
  createdAt: true,
  updatedAt: true,
  submittedForApprovalAt: true,
  approvedAt: true,
  baseCaption: true,
  perPlatformOverrides: true,
  publishMetadata: true,
  coverImageUrl: true,
  mediaItem: { select: { baseCaption: true, perPlatformOverrides: true, deletedAt: true } },
} as const satisfies Prisma.PostJobSelect;

export type PairHalf = Prisma.PostJobGetPayload<{ select: typeof PAIR_HALF_SELECT }> & {
  /** What the other half is: the Story of this feed post, or the feed post of this Story. */
  kind: "story" | "feed";
};

/** What the answer says about the other half. `note` is a sentence for the person. */
export type PairReport = { id: string; kind: PairHalf["kind"]; changed: boolean; note: string };

/** How the action reads in the note: "Its Story {done}." / "…, so it was not {verb}." */
export type PairWording = { done: string; verb: string };

type Db = Pick<Prisma.TransactionClient, "postJob" | "mediaItem">;

/** The request body asks for the action on both halves. */
export function wantsPair(body: Record<string, unknown> | null): boolean {
  return body?.includePair === true;
}

/**
 * The other half of `job`, when the request asked for it: the Story of a feed
 * post, or the feed post of a Story, in this workspace only. A cancelled half
 * is returned too, so the answer can say it was left alone; a deleted one is
 * not found.
 */
export async function readPairHalf(
  workspaceId: string,
  job: { id: string; storyOfPostJobId: string | null },
  includePair: boolean,
): Promise<PairHalf | null> {
  if (!includePair) return null;
  const kind = job.storyOfPostJobId ? "feed" : "story";
  const row = job.storyOfPostJobId
    ? await prisma.postJob.findFirst({
        where: { id: job.storyOfPostJobId, workspaceId },
        select: PAIR_HALF_SELECT,
      })
    : await prisma.postJob.findFirst({
        where: { storyOfPostJobId: job.id, workspaceId },
        orderBy: { createdAt: "asc" },
        select: PAIR_HALF_SELECT,
      });
  if (!row) return null;
  // Only a row that really is the other half (the query asks exactly that; this keeps it so).
  if (kind === "feed" ? row.id !== job.storyOfPostJobId : row.storyOfPostJobId !== job.id) return null;
  return { ...row, kind };
}

/** Only a draft or a scheduled half can still take any Queue action. */
export function isLiveHalf(half: Pick<PairHalf, "status">): boolean {
  return half.status === "draft" || half.status === "scheduled";
}

/** Why a half that moved on is left alone; null while it is a draft or scheduled. */
function movedOnPhrase(status: PostJobStatus): string | null {
  switch (status) {
    case "pending":
    case "in_progress":
      return "has already started publishing";
    case "completed":
      return "was already published";
    case "failed":
      return "was already sent and did not go out";
    case "cancelled":
      return "was already cancelled";
    default:
      return null;
  }
}

function halfName(kind: PairHalf["kind"]): string {
  return kind === "story" ? "Story" : "feed post";
}

function report(half: PairHalf, changed: boolean, phrase: string, wording: PairWording): PairReport {
  const name = halfName(half.kind);
  return {
    id: half.id,
    kind: half.kind,
    changed,
    note: changed ? `Its ${name} ${wording.done}.` : `Its ${name} ${phrase}, so it was not ${wording.verb}.`,
  };
}

/**
 * Runs `write` (the route's pinned, conditional write; true when it changed
 * the row) on this post, then on the other half with that half's own row, in
 * one transaction. A miss on this post writes nothing else (`ok: false`, the
 * route answers as before). The other half is written only while it is live
 * and the route's `blocker` (its own checks, as a phrase) has nothing against it.
 */
export async function applyToPair<R>(args: {
  main: R;
  half: PairHalf | null;
  write: (db: Db, row: R | PairHalf) => Promise<boolean>;
  blocker?: (half: PairHalf) => string | null;
  wording: PairWording;
}): Promise<{ ok: false } | { ok: true; pair: PairReport | null }> {
  const { main, half, write, wording } = args;
  const leftAlone = half ? (movedOnPhrase(half.status) ?? args.blocker?.(half) ?? null) : null;

  if (!half || leftAlone !== null) {
    if (!(await write(prisma, main))) return { ok: false };
    return { ok: true, pair: half && leftAlone !== null ? report(half, false, leftAlone, wording) : null };
  }

  return prisma.$transaction(async (tx) => {
    if (!(await write(tx, main))) return { ok: false as const };
    const changed = await write(tx, half);
    return { ok: true as const, pair: report(half, changed, "changed in the meantime", wording) };
  });
}

/** The note for a half that was claimed but had no connected platform to go to. */
export function notSentNote(kind: PairHalf["kind"]): string {
  return `Its ${halfName(kind)} was not sent: none of its platforms is connected. Activity shows what to reconnect.`;
}

/**
 * Publish now for posts this request just claimed (status in_progress): this
 * post and, for a pair, the other half. Each one's results are made from the
 * connections that exist now; the events go to Inngest in ONE send, so both
 * halves go out or neither is left "publishing". `notSent` holds the posts
 * with no connected platform (prepare already marked them failed, with a
 * sentence per platform); if the send fails, every prepared post's pending
 * results are failed so none hangs.
 */
export async function dispatchNow(
  postJobIds: readonly string[],
  log: { route: string },
): Promise<{ notSent: Set<string>; reasons: Map<string, string>; sendFailed: boolean }> {
  const notSent = new Set<string>();
  const reasons = new Map<string, string>();
  const prepared: string[] = [];
  const events: ReturnType<typeof buildPublishEvent>[] = [];
  for (const id of postJobIds) {
    const prep = await prepareDeferredPostJobDispatch(id);
    if (prep.ok) {
      prepared.push(id);
      // Stable event id + "Post now" priority (2026-11-01 scale audit, jobs H6 + H1).
      events.push(buildPublishEvent(prep.event, { immediate: true }));
    } else {
      notSent.add(id);
      reasons.set(id, prep.reason);
    }
  }
  if (events.length === 0) return { notSent, reasons, sendFailed: false };
  try {
    await inngest.send(events.length === 1 ? events[0] : events);
  } catch (error) {
    logger.error(`[${log.route}] Couldn't dispatch the publish event`, { error, postJobId: prepared[0] });
    for (const id of prepared) await failPendingPostJobResults(id, DISPATCH_FAILURE);
    return { notSent, reasons, sendFailed: true };
  }
  return { notSent, reasons, sendFailed: false };
}

/**
 * The platforms the pair's Story job goes to, for an email that names the
 * Story: the other half's when it is the Story, else this post's own.
 */
export function pairStoryPlatforms(mainPublishMetadata: unknown, half: Pick<PairHalf, "kind" | "publishMetadata">): Platform[] {
  return storyPlatformsOf(half.kind === "story" ? half.publishMetadata : mainPublishMetadata);
}

/**
 * The daily post limit's arguments for an action that commits a post to a day:
 * neither half counts against itself, and a half the action takes too is a
 * second post on that day (as Create counts Feed and Story).
 */
export function pairLimitArgs(
  jobId: string,
  half: PairHalf | null,
): { excludePostJobId: string | string[]; alsoOnDay?: number } {
  if (!half || !isLiveHalf(half)) return { excludePostJobId: jobId };
  return { excludePostJobId: [jobId, half.id], alsoOnDay: 1 };
}
