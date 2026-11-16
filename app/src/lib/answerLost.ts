/**
 * R27 MM3 lead review: the one lead-in for a request that may have gone
 * through. fetchOrNoAnswer cannot tell "offline, nothing sent" from "sent,
 * answer lost", and an unreadable 5xx can come with the connection fine, so
 * the lead-in is true for all three: the answer didn't arrive. Then what may
 * have happened, then where to check.
 * `mayHave`: a lower-case clause without a full stop. `next`: whole sentences.
 */
export function answerLostText(mayHave: string, next: string): string {
  return `Vibe Socials' answer didn't reach you, so ${mayHave}. ${next}`;
}
