/**
 * The paid plans (21a, 2026-11-10) and what each allows. Only limits: prices
 * live with the payment provider (21b), which is the only thing that writes a
 * plan onto a workspace.
 *
 * The owner chose these with the prices ($19, $39 and $79 a month) on
 * 2026-11-11. Posts per day stay low because each post costs about 15
 * background-job runs on a monthly budget every workspace shares; X charges
 * the app for every post (more for one with a link); and YouTube uploads come
 * out of one daily quota for the whole app. The defaults in usageLimits.ts,
 * for exempt workspaces and with billing off, are separate and unchanged.
 */

export type PlanLimits = {
  postsPerDay: number;
  xPostsPerMonth: number;
  youtubeUploadsPerDay: number;
  storageMb: number;
};

export const PLAN_KEYS = ["starter", "growth", "pro"] as const;

export type PlanKey = (typeof PLAN_KEYS)[number];

export const PLANS: Record<PlanKey, { name: string; limits: PlanLimits }> = {
  starter: { name: "Starter", limits: { postsPerDay: 3, xPostsPerMonth: 15, youtubeUploadsPerDay: 1, storageMb: 2048 } },
  growth: { name: "Growth", limits: { postsPerDay: 6, xPostsPerMonth: 40, youtubeUploadsPerDay: 3, storageMb: 5120 } },
  pro: { name: "Pro", limits: { postsPerDay: 15, xPostsPerMonth: 100, youtubeUploadsPerDay: 5, storageMb: 15360 } },
};

export function isPlanKey(value: string | null | undefined): value is PlanKey {
  return typeof value === "string" && (PLAN_KEYS as readonly string[]).includes(value);
}

/**
 * What each plan includes, in words (P1, approved 2026-11-12), for the pricing
 * cards and Settings, Plan. True to lib/planFeatures.ts: Starter has none of
 * the five features, Growth and Pro all of them. "Priority email support" is
 * the operator's promise; no code tells Pro's email apart.
 */
const GROWTH_FEATURES =
  "client upload, review and connect links, a monthly report email with your logo, Add many, brand voice and new-review alerts";

const STARTER_FEATURES =
  "All your platforms, AI captions and alt text, Google posts with buttons, offers and events, AI drafts for Google review replies";

export const PLAN_INCLUDES: Record<PlanKey, string> = {
  starter: STARTER_FEATURES,
  growth: `Everything in Starter, plus ${GROWTH_FEATURES}`,
  pro: "Everything in Growth, with higher limits and priority email support",
};

/**
 * Fix round 2: a plan's line for a view that shows `shown`. "Everything in
 * Starter / Growth" only when that plan is shown too; otherwise its features
 * in full. With only Pro shown, "higher limits" has nothing to be higher than.
 */
export function planIncludesLine(plan: PlanKey, shown: readonly PlanKey[]): string {
  const starterShown = shown.includes("starter");
  if (plan === "starter") return STARTER_FEATURES;
  if (plan === "growth") return starterShown ? PLAN_INCLUDES.growth : `${STARTER_FEATURES}, plus ${GROWTH_FEATURES}`;
  if (shown.includes("growth")) return PLAN_INCLUDES.pro;
  return starterShown
    ? `Everything in Starter, plus ${GROWTH_FEATURES}, with higher limits and priority email support`
    : `${STARTER_FEATURES}, plus ${GROWTH_FEATURES}, and priority email support`;
}

/** Settings, Plan, for a workspace on Starter. */
export const GROWTH_ADDS_LINE = `Growth adds ${GROWTH_FEATURES}.`;
