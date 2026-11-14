import type { Platform } from "@prisma/client";

import { platformLabel } from "@/lib/platforms";
import type { PostJobDTO } from "@/lib/postsDto";

/**
 * R3-client-journey M1 (after R1 H1 and R2 M1): a "Feed and Story" post is two
 * jobs, and each owner action used to act on one half while the other still
 * went out. The Queue now shows the pair as ONE card, as the client review
 * link does (reviewLink.ts foldStoryPairs), and every request about a card is
 * built here, so a pair card always asks the server for both halves
 * (`includePair: true`; the server's rule is api/posts/[postJobId]/pairRule.ts).
 * The answer's `pair` says what happened to the other half, in a sentence the
 * Queue adds to its toast.
 */

/** A Queue card: a post, and for a Feed and Story post its Story folded in. */
export type QueueCard = PostJobDTO & {
  /** The Story half shown on this feed post's card. */
  story?: PostJobDTO;
  /** Every request about this card asks for the other half too. */
  includePair?: true;
};

/** A card, or a bare request that never asks for a pair (a series cancel). */
type PairFlag = QueueCard | { includePair?: true };

/** Both halves still agree on what the card shows: its state, approval and time. */
function sameCard(feed: PostJobDTO, story: PostJobDTO): boolean {
  return (
    feed.status === story.status &&
    feed.approvalState === story.approvalState &&
    (feed.scheduledFor ?? null) === (story.scheduledFor ?? null)
  );
}

/**
 * The Queue's cards from its posts, in their order. A Story whose feed post is
 * listed in the same state, approval and time is folded into that post's card
 * (which takes the feed post's place). A half whose partner is not listed
 * (it moved on, or sits on a page not loaded yet) is its own card and still
 * asks for both halves: the server leaves a partner that moved on alone and
 * says so. Halves that no longer agree stay two cards, each acting alone, and
 * a post with no live partner (no pair marks) is a normal card.
 */
export function foldQueuePairs(jobs: readonly PostJobDTO[]): QueueCard[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const storyOfFeed = new Map<string, PostJobDTO>();
  const listedStoryOf = new Set<string>();
  for (const job of jobs) {
    const feedId = job.storyOf?.id;
    if (!feedId) continue;
    const feed = byId.get(feedId);
    if (!feed) continue;
    listedStoryOf.add(feedId);
    if (sameCard(feed, job)) storyOfFeed.set(feedId, job);
  }
  const folded = new Set(Array.from(storyOfFeed.values(), (story) => story.id));

  const cards: QueueCard[] = [];
  for (const job of jobs) {
    if (folded.has(job.id)) continue;
    const story = storyOfFeed.get(job.id);
    if (story) {
      cards.push({ ...job, story, includePair: true });
      continue;
    }
    const partnerListed = job.storyOf ? byId.has(job.storyOf.id) : listedStoryOf.has(job.id);
    const isHalf = Boolean(job.storyOf || job.alsoAsStory);
    cards.push(isHalf && !partnerListed ? { ...job, includePair: true } : job);
  }
  return cards;
}

/** "Instagram and Facebook Page". */
function joinLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The line on a folded card: "Feed and Story" with each half's platforms. The
 * feed labels are the ones the card already lists; the Story's are its own
 * Story platforms. Null for any other card.
 */
export function foldedPairLine(card: QueueCard, feedLabels: readonly string[]): string | null {
  if (!card.story) return null;
  const targets = card.story.publish?.targetPlatforms ?? null;
  const stories = (card.story.storyPlatforms ?? []).filter((p) => !targets || targets.includes(p));
  const storyLabels = stories.map(platformLabel);
  return `Feed and Story: the post goes to ${joinLabels(feedLabels)}, the Story to ${joinLabels(storyLabels) || "its platforms"}.`;
}

/** The request for an action on a card: JSON, asking for both halves on a pair card. */
export function cardRequest(
  card: PairFlag,
  method: string,
  body: Record<string, unknown> = {},
): { method: string; headers: Record<string, string>; body: string } {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card.includePair ? { ...body, includePair: true } : body),
  };
}

type FetchInit = { method: string; headers: Record<string, string>; body: string };
type FetchAnswer = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * A `fetch` for flows that make their own requests (the Edit dialog's
 * lib/scheduleDraft.ts): on a pair card each JSON request also asks for both
 * halves, and the last answer read is kept so its sentence about the other
 * half can be shown.
 */
export function pairAwareFetch(
  card: PairFlag,
  fetchImpl: (url: string, init: FetchInit) => Promise<FetchAnswer>,
): { fetchFn: (url: string, init: FetchInit) => Promise<FetchAnswer>; lastAnswer: () => unknown } {
  let last: unknown = null;
  const fetchFn = async (url: string, init: FetchInit): Promise<FetchAnswer> => {
    if (!card.includePair) return fetchImpl(url, init);
    let body: unknown = {};
    try {
      body = JSON.parse(init.body);
    } catch {
      // Not JSON: sent as it is.
      return fetchImpl(url, init);
    }
    const response = await fetchImpl(url, { ...init, body: JSON.stringify({ ...(body as object), includePair: true }) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        last = await response.json();
        return last;
      },
    };
  };
  return { fetchFn, lastAnswer: () => last };
}

type PairAnswer = { id: string; changed: boolean; note: string };

/** The answer's `otherHalf` (its `pair` is R2's string, kept for old tabs). */
function pairOf(data: unknown): PairAnswer | null {
  const pair = (data as { otherHalf?: unknown } | null)?.otherHalf as Partial<PairAnswer> | undefined;
  if (!pair || typeof pair.id !== "string" || typeof pair.note !== "string") return null;
  return { id: pair.id, changed: pair.changed === true, note: pair.note };
}

/** The posts an answer changed: this card's, and its other half's when the answer says so. */
export function changedJobIds(card: Pick<QueueCard, "id">, data: unknown): string[] {
  const pair = pairOf(data);
  return pair?.changed ? [card.id, pair.id] : [card.id];
}

/**
 * Whether the Queue reads its posts again after an action on a pair card: the
 * other half was left alone (or is gone), so its own state must show.
 */
export function pairNeedsReload(card: PairFlag, data: unknown): boolean {
  return Boolean(card.includePair) && !pairOf(data)?.changed;
}

/**
 * The toast: the action's own message, then the answer's sentence about the
 * other half. When one half went out and the other did not, the answer's own
 * `message` says both, and is shown instead.
 */
export function withPairNote(message: string, data: unknown): string {
  const own = (data as { message?: unknown } | null)?.message;
  if (typeof own === "string" && own) return own;
  const pair = pairOf(data);
  return pair ? `${message} ${pair.note}` : message;
}

/** The other half a card's action also takes: the folded Story, or the listed partner of a lone half. */
type OtherHalf = { kind: "story" | "feed"; status: string; scheduledFor: string | null; platforms: readonly Platform[] | null };

function otherHalfOf(card: QueueCard): OtherHalf | null {
  if (card.story) {
    const targets = card.story.publish?.targetPlatforms ?? null;
    const stories = (card.story.storyPlatforms ?? []).filter((p) => !targets || targets.includes(p));
    return { kind: "story", status: card.story.status, scheduledFor: card.story.scheduledFor, platforms: stories };
  }
  if (card.includePair && card.pairHalf) return card.pairHalf;
  return null;
}

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

/** "the Story on Instagram, set for Fri, Nov 20, 2026, 3:00 PM" */
function describeHalf(half: OtherHalf): string {
  const platforms = half.platforms?.length
    ? ` on ${joinLabels(half.platforms.map(platformLabel))}`
    : "";
  const time = half.scheduledFor ? `set for ${formatTimestamp(half.scheduledFor)}` : "with no time set";
  return `the ${half.kind === "story" ? "Story" : "feed post"}${platforms}, ${time}`;
}

type DialogAction = "cancel" | "delete" | "publish" | "submit";

/** Whether the action also takes the other half (a delete never takes a scheduled one). */
export function takesOtherHalf(card: QueueCard, action: DialogAction): boolean {
  const half = otherHalfOf(card);
  return half !== null && !(action === "delete" && half.status === "scheduled");
}

/**
 * The confirm dialog's line: the other half the action also takes, with its
 * platforms and time, so nothing goes unnamed even when that half is on a
 * page not loaded yet. Null for a card that is not a pair.
 */
export function pairDialogLine(card: QueueCard, action: DialogAction): string | null {
  const half = otherHalfOf(card);
  if (!half) return null;
  const named = capitalized(describeHalf(half));
  if (!takesOtherHalf(card, action)) {
    return `${named}, is scheduled, so it is not deleted. Cancel it on its own card first.`;
  }
  switch (action) {
    case "cancel":
      return `${named}, is cancelled too.`;
    case "delete":
      return `${named}, is deleted too.`;
    case "publish":
      return `${named}, goes out now too.`;
    case "submit":
      return `${named}, is sent for approval with it.`;
  }
}

/** The Edit dialog's line on a pair card. */
export function pairEditNote(card: QueueCard): string | null {
  const half = otherHalfOf(card);
  return half ? `Changes also go to ${describeHalf(half)}.` : null;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
