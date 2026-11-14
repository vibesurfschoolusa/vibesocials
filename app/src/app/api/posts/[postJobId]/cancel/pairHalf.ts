import type { PostJobStatus, Prisma } from "@prisma/client";

/**
 * R2-client-journey M1: a "Feed and Story" post is two jobs, the Story job
 * naming its feed job in storyOfPostJobId (F6; no foreign key). The Queue's
 * cancel and delete dialogs offer to act on both halves, and rejecting a held
 * pair rejects both, so those routes read the other half here: always in the
 * caller's workspace, and only a live one (a cancelled half is no longer part
 * of the post, as the Queue's labels already treat it).
 */

export const PAIR_HALF_SELECT = {
  id: true,
  storyOfPostJobId: true,
  status: true,
  scheduledFor: true,
  submittedForApprovalAt: true,
  approvedAt: true,
} as const;

export type PairHalf = {
  id: string;
  /** What the other half is: the Story of this feed post, or the feed post of this Story. */
  kind: "story" | "feed";
  status: PostJobStatus;
  scheduledFor: Date | null;
  submittedForApprovalAt: Date | null;
  approvedAt: Date | null;
};

export async function findPairHalf(
  db: { postJob: Pick<Prisma.TransactionClient["postJob"], "findFirst"> },
  workspaceId: string,
  job: { id: string; storyOfPostJobId: string | null },
): Promise<PairHalf | null> {
  const kind = job.storyOfPostJobId ? "feed" : "story";
  const row = job.storyOfPostJobId
    ? await db.postJob.findFirst({
        where: { id: job.storyOfPostJobId, workspaceId },
        select: PAIR_HALF_SELECT,
      })
    : await db.postJob.findFirst({
        where: { storyOfPostJobId: job.id, workspaceId },
        orderBy: { createdAt: "asc" },
        select: PAIR_HALF_SELECT,
      });
  if (!row || row.status === "cancelled") return null;
  // Only a row that really is the other half (the query asks exactly that; this keeps it so).
  if (kind === "feed" ? row.id !== job.storyOfPostJobId : row.storyOfPostJobId !== job.id) return null;
  return {
    id: row.id,
    kind,
    status: row.status,
    scheduledFor: row.scheduledFor,
    submittedForApprovalAt: row.submittedForApprovalAt,
    approvedAt: row.approvedAt,
  };
}
