import { truncateGraphemes } from "@/lib/truncate";

/** Longest caption start a button's name carries, in characters. */
const LABEL_NAME_MAX = 40;

/**
 * The caption in a card button's accessible name (R5-pages L12): one line, at
 * most 40 characters, never cutting inside an emoji, so a screen reader says
 * "Edit "Sunday session at the pier…"" rather than the whole caption.
 */
export function labelName(caption: string | null | undefined): string {
  const line = (caption ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "Untitled post";
  return truncateGraphemes(line, LABEL_NAME_MAX, { ellipsis: "…" });
}

const CARD_TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/**
 * A card's name in its buttons and links. R58 client-journey L1, pages-a L1:
 * a Repeat series makes posts with one caption, so the caption alone gave
 * every card of a series the same name; the time the card shows tells them
 * apart. Short: no weekday or year. `story`: a Story-only card on /v, whose
 * caption is one fixed line, is "Story" plus its time. `storyHalf`: the Story
 * job of a Feed and Story post, which shares the Feed job's caption and time,
 * adds "Story" (R58 fix review L1). `was`: a time the card no longer shows as
 * its own, such as a /v card waiting on changes (R58 fix review L2).
 */
export function cardName(
  caption: string | null | undefined,
  iso: string | null | undefined,
  options: { story?: boolean; storyHalf?: boolean; was?: boolean } = {},
): string {
  const base = options.story ? "Story" : labelName(caption);
  const head = options.storyHalf ? `${base}, Story` : base;
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return head;
  return `${head}, ${options.was ? "was " : ""}${date.toLocaleString(undefined, CARD_TIME)}`;
}

/**
 * R59 client-journey L1: a draft that still carries a time, such as a post the
 * client sent back from /v (the change request keeps its time). A Repeat
 * series is saved in one request, so its save time can't tell its posts
 * apart; the time it was scheduled for can, named with `was`. A post waiting
 * for approval shows its time as Proposed for instead.
 */
export function wasScheduledDraft(job: {
  status: string;
  approvalState?: string | null;
  scheduledFor: string | null;
}): boolean {
  return job.status === "draft" && job.approvalState !== "pending" && Boolean(job.scheduledFor);
}
