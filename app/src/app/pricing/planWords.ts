import type { PlanLimits } from "@/lib/plans";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function gigabytes(mb: number): string {
  const gb = mb / 1024;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
}

/** What a plan allows, one plain line per limit, for the pricing page. */
export function planLimitLines(limits: PlanLimits): string[] {
  return [
    `Up to ${count(limits.postsPerDay, "post", "posts")} a day`,
    `Up to ${count(limits.xPostsPerMonth, "post", "posts")} to X a month`,
    `Up to ${count(limits.youtubeUploadsPerDay, "YouTube upload", "YouTube uploads")} a day`,
    `${gigabytes(limits.storageMb)} GB of photos and videos`,
  ];
}
