/**
 * R27 MM3 lead review: the one lead-in for a request that may have gone
 * through. fetchOrNoAnswer cannot tell "offline, nothing sent" from "sent,
 * answer lost" (nor can an unreadable 5xx), so the text names both, as
 * Create's connectionLostText does: what may have happened, then where to check.
 * `mayHave` and `next` are lower-case clauses without a final full stop.
 */
export function answerLostText(mayHave: string, next: string): string {
  return `We lost the connection before Vibe Socials answered, so ${mayHave}. Check your connection, then ${next}.`;
}
