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
