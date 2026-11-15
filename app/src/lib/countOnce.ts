/**
 * The count-once rule for a Feed and Story post (R5-client-journey L2). Such a
 * post is two jobs, the Story naming its feed job (PostJob.storyOfPostJobId),
 * but it is one post to the owner, as the Queue's one card shows it. Among the
 * jobs that match one question (failed, waiting for approval, published this
 * month), a Story job whose feed job matches too is left out. A Story whose feed
 * job does not match stands alone and counts.
 *
 * Every count uses this: the dashboard's Needs you card, the Workspaces page,
 * the daily digest and the monthly report.
 */

export interface PairableJob {
  id: string;
  storyOfPostJobId: string | null;
}

/** The jobs with every Story whose feed job is in the same list taken out. */
export function withoutPairedStories<T extends PairableJob>(jobs: readonly T[]): T[] {
  const ids = new Set(jobs.map((job) => job.id));
  return jobs.filter((job) => !(job.storyOfPostJobId && ids.has(job.storyOfPostJobId)));
}

/** How many posts the jobs are: distinct jobs, a pair counted once. */
export function countPostsOnce(jobs: readonly PairableJob[]): number {
  const distinct = new Map<string, PairableJob>();
  for (const job of jobs) distinct.set(job.id, job);
  return withoutPairedStories([...distinct.values()]).length;
}
