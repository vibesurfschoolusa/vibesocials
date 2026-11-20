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
