import type { Platform } from "@prisma/client";

import { platformLabel } from "./platforms";

/**
 * R7 review, points 1 and 2: the one rule for what "Retry all failed" covers,
 * used by the Activity card (whether to show the button) and the retry route
 * (what an {all} request claims). A failed platform is left out when its
 * outcome is unknown (it may already be live, so retrying could post it
 * twice) or when its connection needs reconnecting (it would only fail
 * again). Pure: no database, safe in the browser.
 */

export type LeftOutReason = "unconfirmed" | "reconnect";
export type LeftOut = { platform: Platform; reason: LeftOutReason };

/**
 * R27 MM4 review: the step a failed row gets, read by Retry all failed (here)
 * and by the outcome email, so the email names the control the Activity card
 * offers: check the platform first (it may be live), reconnect, or Retry.
 */
export type FailedRowStep = "check_platform" | "reconnect" | "retry";

export function failedRowStep(result: { unconfirmed: boolean }, needsReconnect: boolean): FailedRowStep {
  if (result.unconfirmed) return "check_platform";
  return needsReconnect ? "reconnect" : "retry";
}

/** No connection for the platform, or one flagged as needing a reconnect. */
export function needsReconnecting(connection: { needsReconnect: boolean } | null | undefined): boolean {
  return !connection || connection.needsReconnect;
}

export function retryAllPlan(
  results: ReadonlyArray<{ platform: Platform; status: string; unconfirmed: boolean }>,
  needsReconnect: (platform: Platform) => boolean,
): { included: Platform[]; leftOut: LeftOut[] } {
  const included: Platform[] = [];
  const leftOut: LeftOut[] = [];
  for (const result of results) {
    if (result.status !== "failed") continue;
    const step = failedRowStep(result, needsReconnect(result.platform));
    if (step === "check_platform") leftOut.push({ platform: result.platform, reason: "unconfirmed" });
    else if (step === "reconnect") leftOut.push({ platform: result.platform, reason: "reconnect" });
    else included.push(result.platform);
  }
  return { included, leftOut };
}

/**
 * What was left out and what to do about each, or null when nothing was. Only
 * an owner can reconnect, so a member's names the owner (R10-client-journey L1).
 */
export function leftOutSentence(leftOut: readonly LeftOut[], role: "owner" | "member" = "owner"): string | null {
  if (leftOut.length === 0) return null;
  return leftOut
    .map(({ platform, reason }) =>
      reason === "unconfirmed"
        ? `${platformLabel(platform)} left out: check whether it posted first.`
        : role === "member"
          ? `${platformLabel(platform)} left out: the workspace owner can reconnect it.`
          : `${platformLabel(platform)} left out: reconnect it in Settings.`,
    )
    .join(" ");
}
