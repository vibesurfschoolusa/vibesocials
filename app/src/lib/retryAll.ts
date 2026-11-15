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

export function retryAllPlan(
  results: ReadonlyArray<{ platform: Platform; status: string; unconfirmed: boolean }>,
  needsReconnect: (platform: Platform) => boolean,
): { included: Platform[]; leftOut: LeftOut[] } {
  const included: Platform[] = [];
  const leftOut: LeftOut[] = [];
  for (const result of results) {
    if (result.status !== "failed") continue;
    if (result.unconfirmed) leftOut.push({ platform: result.platform, reason: "unconfirmed" });
    else if (needsReconnect(result.platform)) leftOut.push({ platform: result.platform, reason: "reconnect" });
    else included.push(result.platform);
  }
  return { included, leftOut };
}

/** What was left out and what to do about each, or null when nothing was. */
export function leftOutSentence(leftOut: readonly LeftOut[]): string | null {
  if (leftOut.length === 0) return null;
  return leftOut
    .map(({ platform, reason }) =>
      reason === "unconfirmed"
        ? `${platformLabel(platform)} left out: check whether it posted first.`
        : `${platformLabel(platform)} left out: reconnect it in Settings.`,
    )
    .join(" ");
}
