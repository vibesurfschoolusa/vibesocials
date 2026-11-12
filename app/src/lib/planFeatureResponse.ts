import { NextResponse } from "next/server";

import type { BillingEnv, BillingFields } from "./billing";
import { PLAN_FEATURE_CODE, PLAN_FEATURE_MESSAGES, planIncludes, type PlanFeature } from "./planFeatures";

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
