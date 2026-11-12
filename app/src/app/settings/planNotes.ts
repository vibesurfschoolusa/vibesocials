import type { BillingEnv, BillingFields } from "@/lib/billing";
import { planIncludes } from "@/lib/planFeatures";

/**
 * P1: the lines Settings shows where the plan leaves a feature out. The
 * fields and the toggle stay and keep saving; only what the app does with
 * them waits for Growth or Pro. Empty (no line, the form as before) whenever
 * the plan includes the feature, billing is off, or the workspace is exempt.
 */

/** Fix round 2: replaces the brand voice section's own sentence, which is untrue without the feature. */
export const BRAND_VOICE_PLAN_NOTE =
  "On the Growth and Pro plans, the AI follows this when it writes or rewrites a caption and when it drafts a reply to a Google review.";
export const REVIEW_ALERTS_PLAN_NOTE =
  "New-review emails are sent on the Growth and Pro plans. Your choice here is kept for when you choose one.";

// P1 fix round 2: the monthly report email toggle and the logo.
export const MONTHLY_REPORT_PLAN_NOTE = "The monthly report email is part of the Growth and Pro plans.";
export const LOGO_PLAN_NOTE = "Your logo shows on the monthly report on the Growth and Pro plans.";

export type SettingsPlanNotes = { brandVoice?: string; reviewAlerts?: string; monthlyReport?: string; logo?: string };

export function settingsPlanNotes(
  workspace: BillingFields,
  env: BillingEnv = process.env,
  now: Date = new Date(),
): SettingsPlanNotes {
  return {
    ...(planIncludes(workspace, "brandVoice", env, now) ? {} : { brandVoice: BRAND_VOICE_PLAN_NOTE }),
    ...(planIncludes(workspace, "reviewAlerts", env, now) ? {} : { reviewAlerts: REVIEW_ALERTS_PLAN_NOTE }),
    ...(planIncludes(workspace, "monthlyReportEmail", env, now)
      ? {}
      : { monthlyReport: MONTHLY_REPORT_PLAN_NOTE, logo: LOGO_PLAN_NOTE }),
  };
}
