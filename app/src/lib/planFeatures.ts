import { NextResponse } from "next/server";

import { billingEnabled, planState, type BillingEnv, type BillingFields } from "./billing";

/**
 * What each plan includes beyond its limits (P1, approved 2026-11-12). The one
 * rule every gated place calls; nothing else decides whether a workspace has a
 * feature. Pure apart from reading the environment.
 *
 * - Billing off: every feature, as before plans differed.
 * - Exempt (by its flag, or created with billing off): every feature.
 * - Trial: every feature, so a new person can try what Growth adds. The limits
 *   stay Starter's (usageLimits.ts), as before.
 * - Active: Growth and Pro include every feature; Starter none. An unknown plan
 *   value includes none: only the payment provider writes the column, and it
 *   writes a known plan, so an unknown one is a mistake that should not unlock
 *   paid features.
 * - Ended: none. The workspace is blocked from new work (workspaceStatus.ts)
 *   anyway, and its client links already answer as inactive.
 */

export const PLAN_FEATURES = ["clientLinks", "bulk", "brandVoice", "monthlyReportEmail", "reviewAlerts"] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** The plans that include every feature when active. */
const FEATURE_PLANS: readonly string[] = ["growth", "pro"];

export function planIncludes(
  workspace: BillingFields,
  // Every feature follows the same rule today; the name keeps each call site explicit.
  _feature: PlanFeature,
  env: BillingEnv = process.env,
  now: Date = new Date(),
): boolean {
  if (!billingEnabled(env)) return true;
  const state = planState(workspace, now);
  if (state === "exempt" || state === "trial") return true;
  if (state === "ended") return false;
  return typeof workspace.plan === "string" && FEATURE_PLANS.includes(workspace.plan);
}

export const PLAN_FEATURE_CODE = "PLAN_FEATURE";

const CHOOSE = "part of the Growth and Pro plans. Choose a plan in Settings, Plan.";

/** What a refused request answers, per feature. */
export const PLAN_FEATURE_MESSAGES: Record<PlanFeature, string> = {
  clientLinks: `Client links are ${CHOOSE}`,
  bulk: `Add many is ${CHOOSE}`,
  brandVoice: `Brand voice is ${CHOOSE}`,
  monthlyReportEmail: `The report logo and the monthly report email are ${CHOOSE}`,
  reviewAlerts: `New-review emails are ${CHOOSE}`,
};

/** For a route: the 403 to return as-is, or null to carry on. */
export function planFeatureResponse(
  workspace: BillingFields,
  feature: PlanFeature,
  env: BillingEnv = process.env,
  now: Date = new Date(),
): NextResponse | null {
  if (planIncludes(workspace, feature, env, now)) return null;
  return NextResponse.json({ error: PLAN_FEATURE_MESSAGES[feature], code: PLAN_FEATURE_CODE }, { status: 403 });
}
