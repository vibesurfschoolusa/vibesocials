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
