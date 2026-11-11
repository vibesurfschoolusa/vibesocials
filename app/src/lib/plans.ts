/**
 * The paid plans (21a, 2026-11-10) and what each allows. Only limits: prices
 * live with the payment provider (21b), which is the only thing that writes a
 * plan onto a workspace.
 *
 * Placeholder numbers: starter is today's defaults in usageLimits.ts (written
 * out here, not imported, so the two files do not import each other), growth
 * twice them and pro five times. The operator sets the real numbers before
 * switching billing on.
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
  starter: { name: "Starter", limits: { postsPerDay: 20, xPostsPerMonth: 30, youtubeUploadsPerDay: 10, storageMb: 5120 } },
  growth: { name: "Growth", limits: { postsPerDay: 40, xPostsPerMonth: 60, youtubeUploadsPerDay: 20, storageMb: 10240 } },
  pro: { name: "Pro", limits: { postsPerDay: 100, xPostsPerMonth: 150, youtubeUploadsPerDay: 50, storageMb: 25600 } },
};

export function isPlanKey(value: string | null | undefined): value is PlanKey {
  return typeof value === "string" && (PLAN_KEYS as readonly string[]).includes(value);
}
