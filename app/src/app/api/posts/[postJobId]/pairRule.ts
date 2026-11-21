import type { Platform, PostJobStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { connectionStepSentence, stepsForRows, type ConnectionStep } from "@/lib/connectionSteps";
import { inngest } from "@/lib/inngest";
import { otherHalfStartText, type FailedStart } from "@/lib/composerSubmitOutcome";
import { logger } from "@/lib/logger";
import { sentenceForRecipient } from "@/lib/publishFailureText";
import { storyPlatformsOf } from "@/lib/storyPlacement";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import { LIMIT_CHECK_FAILED_CODE, LIMIT_CHECK_FAILED_MESSAGE, type LimitSteps } from "@/lib/usageLimits";
import { reserveFreeRuns, withdrawSend, type WrittenSends } from "@/server/usage/usageLog";
import { buildPublishEvent, deferredPostCanSend, prepareDeferredPostJobDispatch } from "@/server/jobs/posting";


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
      // R32 client-journey L7: a failed half may never have been sent (no
      // connection, a pause, the daily limit), so it says nothing about sending.
      return "failed";
    case "cancelled":
      return "was already cancelled";
    default:
      return null;
  }
}

function halfName(kind: PairHalf["kind"]): "Story" | "feed post" {
  return kind === "story" ? "Story" : "feed post";
}

function report(half: PairHalf, changed: boolean, phrase: string, wording: PairWording): PairReport {
  const name = halfName(half.kind);
  return {
    id: half.id,
    kind: half.kind,
    changed,
    note: changed
      ? `Its ${name} ${wording.done}.`
      : `Its ${name} ${phrase}, so it was not ${wording.verb}.${half.status === "failed" ? " Check Activity for what to do next." : ""}`,
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

/** Who reads an answer: only an owner can connect or reconnect (R11-publishing L1). */
type ViewerRole = "owner" | "member";

/**
 * The note for a half that was claimed but had no connected platform to go to.
 * `steps`: its failed rows' steps (dispatchNow's `connectionSteps`); none known
 * reads "connect or reconnect" (R59 pages-a L1).
 */
export function notSentNote(kind: PairHalf["kind"], role: ViewerRole = "owner", steps: readonly ConnectionStep[] = []): string {
  return `Its ${halfName(kind)} was not sent: ${noPlatformConnected(role, steps)}`;
}

/**
 * R29 publishing L1 + L2: the 503 fields after a failed start. `resultsMarked`
 * and `withoutResults` are the pressed post's own; a claimed other half (one
 * that had a platform to go to) gets its note by its own state, also returned
 * as `halfNote` for the member's email (with `halfMayHaveStarted` for its subject). A half left alone keeps its note.
 */
export function failedStartAnswer(
  postJobId: string,
  pair: PairReport | null,
  dispatch: DispatchResult,
): {
  body: { resultsMarked: boolean; withoutResults?: true; otherHalf?: PairReport };
  halfNote?: string;
  /** The claimed other half's marking threw: it may still go out. */
  halfMayHaveStarted?: boolean;
} {
  const start = failedStartOf(dispatch, postJobId);
  const own = { resultsMarked: start.resultsMarked, ...(start.withoutResults ? { withoutResults: true as const } : {}) };
  if (!pair) return { body: own };
  if (!pair.changed || dispatch.notSent.has(pair.id)) return { body: { ...own, otherHalf: pair } };
  const half = failedStartOf(dispatch, pair.id);
  const halfNote = otherHalfStartText(halfName(pair.kind), half);
  return { body: { ...own, otherHalf: { ...pair, note: halfNote } }, halfNote, halfMayHaveStarted: !half.resultsMarked };
}

function failedStartOf(dispatch: DispatchResult, id: string): FailedStart {
  return { resultsMarked: !dispatch.unmarked.has(id), withoutResults: dispatch.withoutResults.has(id) };
}

/** What `dispatchNow` did with each claimed post. */
export type DispatchResult = {
  /** Handed to Inngest. */
  sent: Set<string>;
  /** No connected platform to go to (prepare marked them failed). */
  notSent: Set<string>;
  /** prepare's reason code for each post in `notSent`. */
  reasons: Map<string, string>;
  /**
   * R59 pages-a L1: for a post in `notSent` with no connection to go to, the
   * steps its failed rows ask for (from their codes), so the answer says Connect
   * or Reconnect as Settings does. Missing when the rows couldn't be read.
   */
  connectionSteps: Map<string, ConnectionStep[]>;
  /**
   * Only when some went out and some did not: each one in `notSent`'s first
   * failed result (its sentence as stored, and its platform), or null if none.
   */
  whyNotSent: Map<string, { errorMessage: string; platform: Platform } | null>;
  /** Review of T1, item 1: posts a daily limit refused as they went out, with the sentence and code. */
  limitRefusals: Map<string, { error: string; code: string }>;
  sendFailed: boolean;
  /**
   * R26 LL3: when the send failed, whether every claimed post's results were
   * marked failed. False: one is left pending and shows as publishing until
   * the stuck-job reconciler fails it (as the create route's 503 says).
   */
  resultsMarked: boolean;
  /** R29 publishing L1 + L2: the claimed posts whose marking threw (each half's own state). */
  unmarked: Set<string>;
  /**
   * R28 publishing L2: claimed posts the failed start left with no results at
   * all (prepare threw before it wrote them). Such a post reads "not sent" in
   * Activity and offers Send again, not Retry, so the answers say to press Send
   * again. A post whose results couldn't be counted is left out.
   */
  withoutResults: Set<string>;
};

function noPlatformConnected(role: ViewerRole, steps: readonly ConnectionStep[]): string {
  return `each of its platforms is either not connected or needs reconnecting. ${connectionStepSentence({ form: "activity", steps }, role)}`;
}

/**
 * Publish now for posts this request just claimed (status in_progress): this
 * post and, for a pair, the other half. Each one's results are made from the
 * connections that exist now; the events go to Inngest in ONE send, so both
 * halves go out or neither is left "publishing". A post with no connected
 * platform is in `notSent` (prepare already marked it failed, with a sentence
 * per platform); if the send fails, every prepared post's pending results are
 * failed so none hangs.
 */
/**
 * Second look at T1, item 1: what a route's reservation before its claim
 * gave: the runs it wrote, or the answer to give with nothing changed (429
 * with the limit's sentence, or 503 when the limits could not be checked).
 */
export type SendNowReservation =
  | { ok: true; reserved: WrittenSends }
  | { ok: false; status: 429 | 503; body: { error: string; code: string } };

/**
 * Publish and approve now reserve the runs before they claim anything: this
 * post and the other half the action takes, those with something to send, in
 * one reservation (both or neither), under the service-wide lock for a free
 * workspace. Refused, or unable to check, nothing has changed yet. Never throws.
 */
export async function reserveSendNow(args: {
  workspaceId: string;
  postJobIds: readonly string[];
  viewerUserId: string;
  /** R55 pages-a-3 L1: the approver's steps for a refusal's sentence; only the words change. */
  steps?: LimitSteps;
}): Promise<SendNowReservation> {
  const day = new Date();
  try {
    const sendable: string[] = [];
    for (const id of args.postJobIds) if (await deferredPostCanSend(id)) sendable.push(id);
    const reservation = await reserveFreeRuns({
      workspaceId: args.workspaceId,
      postJobIds: sendable,
      at: day,
      check: "now",
      viewerUserId: args.viewerUserId,
      ...(args.steps ? { steps: args.steps } : {}),
    });
    if (!reservation.ok) return { ok: false, status: 429, body: reservation.refusal };
    return { ok: true, reserved: { postJobIds: reservation.written, day } };
  } catch (error) {
    logger.error("[posts] Couldn't reserve a post going out now", { error, workspaceId: args.workspaceId });
    return { ok: false, status: 503, body: { error: LIMIT_CHECK_FAILED_MESSAGE, code: LIMIT_CHECK_FAILED_CODE } };
  }
}

/** Takes back the reserved runs of the posts the claim did not take (`kept`: those it did). Never throws. */
export async function releaseReservation(reserved: WrittenSends, kept: readonly string[] = []): Promise<void> {
  const unclaimed = reserved.postJobIds.filter((id) => !kept.includes(id));
  if (unclaimed.length > 0) await withdrawSend({ postJobIds: unclaimed, day: reserved.day });
}

export async function dispatchNow(
  postJobIds: readonly string[],
  log: { route: string },
  /** Second look at T1, item 1: the route's reservation; prepare then reserves nothing itself. */
  options: { reserved?: WrittenSends } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = {
    sent: new Set(),
    notSent: new Set(),
    reasons: new Map(),
    connectionSteps: new Map(),
    whyNotSent: new Map(),
    limitRefusals: new Map(),
    sendFailed: false,
    resultsMarked: true,
    unmarked: new Set(),
    withoutResults: new Set(),
  };
  const prepared: string[] = [];
  const events: ReturnType<typeof buildPublishEvent>[] = [];
  // Third review of K2: the sends prepare wrote, taken back if the hand-over fails.
  const sendsWritten: WrittenSends[] = options.reserved ? [options.reserved] : [];
  // Second look at T1, item 2: every post here is claimed; one that throws
  // fails them all (none is left in_progress without results), takes back
  // the runs, and the route answers 503.
  const failAll = async (error: unknown) => {
    logger.error(`[${log.route}] Couldn't prepare a claimed post; failing it`, { error, postJobIds });
    for (const id of postJobIds) {
      try {
        await failPendingPostJobResults(id, DISPATCH_FAILURE);
      } catch (failError) {
        logger.error(`[${log.route}] Couldn't fail a claimed post (the stuck-job sweep will)`, { error: failError, postJobId: id });
        result.resultsMarked = false;
        result.unmarked.add(id);
      }
    }
    for (const written of sendsWritten) await withdrawSend(written);
    for (const id of postJobIds) {
      try {
        if ((await prisma.postJobResult.count({ where: { postJobId: id } })) === 0) result.withoutResults.add(id);
      } catch (countError) {
        logger.error(`[${log.route}] Couldn't count a failed post's results`, { error: countError, postJobId: id });
      }
    }
    result.sendFailed = true;
    return result;
  };
  for (const id of postJobIds) {
    let prep: Awaited<ReturnType<typeof prepareDeferredPostJobDispatch>>;
    try {
      // Review of T1, item 1: reserved under the service-wide lock, by the
      // route before its claim (reserved) or here as it goes out (sendNow).
      prep = await prepareDeferredPostJobDispatch(id, options.reserved ? { reserved: true } : { sendNow: true });
    } catch (error) {
      return failAll(error);
    }
    if (prep.ok) {
      prepared.push(id);
      if (prep.sendsWritten) sendsWritten.push(prep.sendsWritten);
      // Stable event id + "Post now" priority (2026-11-01 scale audit, jobs H6 + H1).
      events.push(buildPublishEvent(prep.event, { immediate: true }));
    } else {
      result.notSent.add(id);
      result.reasons.set(id, prep.reason);
      if (prep.reason === "LIMIT_REACHED" && prep.refusal) {
        result.limitRefusals.set(id, { error: prep.refusal.errorMessage, code: prep.refusal.errorCode });
      }
    }
  }
  // R59 pages-a L1: what each post with no connection to go to needs, from
  // its failed rows' codes. Unread, the answer says "connect or reconnect".
  for (const [id, reason] of result.reasons) {
    if (reason !== "NO_CONNECTIONS") continue;
    try {
      const rows = await prisma.postJobResult.findMany({
        where: { postJobId: id, status: "failed" },
        select: { platform: true, status: true, errorCode: true },
      });
      result.connectionSteps.set(id, stepsForRows(rows).map((entry) => entry.step));
    } catch (error) {
      logger.error(`[${log.route}] Couldn't read why a post was not sent`, { error, postJobId: id });
    }
  }
  // A reserved post with nothing to send after all makes no run.
  if (options.reserved && result.notSent.size > 0) {
    await withdrawSend({
      postJobIds: options.reserved.postJobIds.filter((id) => result.notSent.has(id)),
      day: options.reserved.day,
    });
  }
  if (events.length === 0) return result;
  try {
    await inngest.send(events.length === 1 ? events[0] : events);
  } catch (error) {
    logger.error(`[${log.route}] Couldn't dispatch the publish event`, { error, postJobId: prepared[0] });
    // R26 LL3, the create route's rule (KK4): the posts exist, so marking is
    // per post and best-effort; a throw here must not become a bare 500. One
    // left pending is failed by the stuck-job reconciler (scheduledScanner.ts).
    const marked: string[] = [];
    for (const id of prepared) {
      try {
        await failPendingPostJobResults(id, DISPATCH_FAILURE);
        marked.push(id);
      } catch (markError) {
        logger.error(`[${log.route}] Couldn't mark the undispatched results failed`, { error: markError, postJobId: id });
        result.resultsMarked = false;
        result.unmarked.add(id);
      }
    }
    // Not handed to publishing: a send already there from earlier that day was
    // never reported, so it stays. A post left pending may still publish (the
    // send may have arrived), so its count stays too, as on Create.
    for (const written of sendsWritten) {
      const withdrawn = written.postJobIds.filter((id) => marked.includes(id));
      if (withdrawn.length > 0) await withdrawSend({ ...written, postJobIds: withdrawn });
    }
    result.sendFailed = true;
    return result;
  }
  for (const id of prepared) result.sent.add(id);
  // Review of R3: one half went out and the other did not, so the answer says
  // why, with the first platform's own sentence (e.g. "Reconnect Facebook Page
  // in Settings, then retry.").
  for (const id of result.notSent) {
    let why: { errorMessage: string; platform: Platform } | null = null;
    try {
      const failed = await prisma.postJobResult.findFirst({
        where: { postJobId: id, status: "failed" },
        orderBy: { createdAt: "asc" },
        select: { errorMessage: true, platform: true },
      });
      if (failed?.errorMessage) why = { errorMessage: failed.errorMessage, platform: failed.platform };
    } catch (error) {
      logger.error(`[${log.route}] Couldn't read why a post was not sent`, { error, postJobId: id });
    }
    result.whyNotSent.set(id, why);
  }
  return result;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Review of R3: the answer's sentence when one half of a pair went out and the
 * other had nothing it could send, e.g. "The Story is being sent. The feed post
 * was not: Reconnect Facebook Page in Settings." Null otherwise (both went,
 * neither went, not a pair, or the send failed). A member reads the stored
 * sentence's member form (R11-publishing L1).
 */
export function partialSendMessage(
  postJobId: string,
  half: PairHalf | null,
  dispatch: DispatchResult,
  role: ViewerRole = "owner",
): string | null {
  if (!half || dispatch.sendFailed) return null;
  const mainKind: PairHalf["kind"] = half.kind === "story" ? "feed" : "story";
  const [sentKind, notKind, notId] = dispatch.sent.has(postJobId) && dispatch.notSent.has(half.id)
    ? [mainKind, half.kind, half.id]
    : dispatch.sent.has(half.id) && dispatch.notSent.has(postJobId)
      ? [half.kind, mainKind, postJobId]
      : [null, null, null];
  if (!sentKind || !notKind || !notId) return null;
  const stored = dispatch.whyNotSent.get(notId) ?? null;
  const why = stored
    ? (sentenceForRecipient(stored.errorMessage, stored.platform, role) ?? stored.errorMessage)
    : noPlatformConnected(role, dispatch.connectionSteps.get(notId) ?? []);
  return `The ${halfName(sentKind)} is being sent. ${capitalized(`the ${halfName(notKind)}`)} was not: ${why}`;
}

/**
 * The platforms the pair's Story job goes to, for an email that names the
 * Story: the other half's when it is the Story, else this post's own.
 */
export function pairStoryPlatforms(mainPublishMetadata: unknown, half: Pick<PairHalf, "kind" | "publishMetadata">): Platform[] {
  return storyPlatformsOf(half.kind === "story" ? half.publishMetadata : mainPublishMetadata);
}

/**
 * R4 lows, item 3: an email about a pair action describes the feed post (its
 * platforms and texts) and names the Story. That is the other half when it is
 * the feed post and the action took it too; null when it is this post.
 */
export function takenFeedHalf(half: PairHalf | null, pair: PairReport | null): PairHalf | null {
  return half && half.kind === "feed" && pair?.changed ? half : null;
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
