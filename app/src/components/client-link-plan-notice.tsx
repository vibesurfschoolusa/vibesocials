import Link from "next/link";

/**
 * P1 fix round 1: what a client link panel says where the plan does not
 * include client links (the owner GET answers pausedByPlan). A link that
 * exists is paused, not revoked: its public page answers as an inactive link
 * until the workspace is on Growth or Pro again.
 */

export const CLIENT_LINK_PAUSED_SENTENCE =
  "This link is paused: client links are part of the Growth and Pro plans. Your link comes back when you choose one of them.";

/** Fix round 2: a connect link expires, so it comes back only if a plan is chosen before then. */
export const CONNECT_LINK_PAUSED_SENTENCE =
  "This link is paused: client links are part of the Growth and Pro plans. Your link comes back if you choose one of them before it expires.";

/** With no link there is nothing paused, so the sentence names only the plans. */
export const CLIENT_LINK_NOT_INCLUDED_SENTENCE = "Client links are part of the Growth and Pro plans.";

export function ClientLinkPlanNotice({ paused, expires = false }: { paused: boolean; expires?: boolean }) {
  const pausedSentence = expires ? CONNECT_LINK_PAUSED_SENTENCE : CLIENT_LINK_PAUSED_SENTENCE;
  return (
    <p className="text-sm text-muted-foreground">
      {paused ? pausedSentence : CLIENT_LINK_NOT_INCLUDED_SENTENCE}{" "}
      <Link href="/settings#plan" className="font-medium text-primary underline-offset-4 hover:underline">
        Choose a plan in Settings, Plan
      </Link>
      .
    </p>
  );
}
