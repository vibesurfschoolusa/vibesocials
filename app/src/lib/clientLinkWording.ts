/**
 * What blocks the client links: a pause ends when the workspace is active
 * again, an ended trial or plan only on Growth or Pro (II1 review: picking
 * Starter makes the workspace active but leaves the links off).
 */
export type ClientLinkBlockKind = "pause" | "plan";

/**
 * When a blocked workspace's kept copies work again, in the kind's words. One
 * sentence for the Team card, its demotion toast and the former-owner email
 * (R24). The plan kind has no "again": a trial was never on Growth or Pro.
 */
export function copiesWorkAgainWhen(kind: ClientLinkBlockKind | null | undefined): string {
  return kind === "plan" ? "once the workspace is on Growth or Pro" : "once the workspace is active again";
}

/**
 * R50 pages-a L1: what a failed "Make new client links" says, from the route
 * and as Team's own fallback. It claims nothing about the old links: a
 * connect link whose maker stopped being an owner works for nobody, and a
 * commit whose answer was lost may have replaced them all. Reading each link
 * again where it lives shows the truth either way. R51 pages-a L1: Team shows
 * it in a toast that closes after 8 seconds, and its panel doesn't list the
 * links, so it stays short and names where each one lives.
 */
export const CLIENT_LINKS_NOT_MADE_MESSAGE =
  "We couldn't confirm the new client links were made. Reload, then copy each link again: upload on Media, review on Queue, connect under Connections.";
