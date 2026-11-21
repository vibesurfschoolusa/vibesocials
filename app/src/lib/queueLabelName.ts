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
 * caption is one fixed line, is "Story" plus its time.
 */
export function cardName(
  caption: string | null | undefined,
  iso: string | null | undefined,
  options: { story?: boolean } = {},
): string {
  const head = options.story ? "Story" : labelName(caption);
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return head;
  return `${head}, ${date.toLocaleString(undefined, CARD_TIME)}`;
}
