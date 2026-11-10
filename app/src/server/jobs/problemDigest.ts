import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { utcDayKey } from "@/lib/usageLimits";
import { sendEmail } from "@/server/notifications/email";
import {
  buildProblemDigestEmail,
  type ProblemDigestWorkspace,
} from "@/server/notifications/problemDigestEmail";

/**
 * The daily problems email (2026-11-10). `collectProblemDigests` finds the
 * workspaces with a problem and groups them by owner; `sendProblemDigests`
 * emails each owner once. The `daily-problem-digest` cron runs one step each.
 *
 * A digest carries ids, names and counts only. Owners' addresses are read in
 * the send step, so they never land in a step's stored output.
 */

/** A run sends at most this many emails; the rest are logged and wait for tomorrow. */
export const DIGEST_MAX_EMAILS_PER_RUN = 200;

/** How far back a failed result counts as today's problem. */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProblemDigest {
  userId: string;
  workspaces: ProblemDigestWorkspace[];
}

export interface ProblemDigestSendResult {
  sent: number;
  failed: number;
  /** Digests over the per-run cap, not sent. */
  left: number;
}

function emptyProblems(workspaceId: string): Omit<ProblemDigestWorkspace, "name"> {
  return { workspaceId, failedPosts: 0, failedPlatforms: [], needsReconnect: [], waitingForApproval: 0 };
}

/**
 * One digest per owner who wants the email and owns at least one workspace with
 * a problem: a result that failed in the 24 hours before `now` (and is still
 * failed, so a retry that succeeded does not count), a connection that needs
 * reconnecting, or a post waiting for approval. Ordered by user id, so a re-run
 * that hits the cap picks the same owners.
 */
export async function collectProblemDigests(now: Date): Promise<ProblemDigest[]> {
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);

  const [failedResults, reconnects, approvals] = await Promise.all([
    prisma.postJobResult.findMany({
      where: {
        status: "failed",
        updatedAt: { gte: since, lte: now },
        workspaceId: { not: null },
      },
      select: { workspaceId: true, postJobId: true, platform: true },
    }),
    prisma.socialConnection.findMany({
      where: { needsReconnect: true },
      select: { workspaceId: true, platform: true },
    }),
    // Held for approval: a draft submitted and not yet decided. The status
    // filter is what keeps a rejected (cancelled) post out, as in
    // deriveApprovalState / isHeldForApproval (lib/approval.ts).
    prisma.postJob.groupBy({
      by: ["workspaceId"],
      where: { status: "draft", submittedForApprovalAt: { not: null }, approvedAt: null },
      _count: { _all: true },
    }),
  ]);

  const problems = new Map<string, Omit<ProblemDigestWorkspace, "name">>();
  const problemsOf = (workspaceId: string) => {
    let entry = problems.get(workspaceId);
    if (!entry) {
      entry = emptyProblems(workspaceId);
      problems.set(workspaceId, entry);
    }
    return entry;
  };

  // A post that failed on two platforms is one failed post.
  const failures = new Map<string, { posts: Set<string>; platforms: Set<Platform> }>();
  for (const result of failedResults) {
    if (!result.workspaceId) continue;
    const failure = failures.get(result.workspaceId) ?? { posts: new Set(), platforms: new Set() };
    failure.posts.add(result.postJobId);
    failure.platforms.add(result.platform);
    failures.set(result.workspaceId, failure);
  }
  for (const [workspaceId, failure] of failures) {
    const entry = problemsOf(workspaceId);
    entry.failedPosts = failure.posts.size;
    entry.failedPlatforms = [...failure.platforms].sort();
  }
  for (const connection of reconnects) {
    problemsOf(connection.workspaceId).needsReconnect.push(connection.platform);
  }
  for (const entry of problems.values()) entry.needsReconnect.sort();
  for (const group of approvals) {
    if (group._count._all > 0) problemsOf(group.workspaceId).waitingForApproval = group._count._all;
  }

  if (problems.size === 0) return [];

  const owners = await prisma.workspaceMember.findMany({
    where: {
      workspaceId: { in: [...problems.keys()] },
      role: "owner",
      user: { notifyDailyDigest: true },
    },
    select: { userId: true, workspaceId: true, workspace: { select: { name: true } } },
  });

  const byUser = new Map<string, ProblemDigestWorkspace[]>();
  for (const owner of owners) {
    const entry = problems.get(owner.workspaceId);
    if (!entry) continue;
    const list = byUser.get(owner.userId) ?? [];
    list.push({ ...entry, name: owner.workspace.name });
    byUser.set(owner.userId, list);
  }

  return [...byUser.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([userId, workspaces]) => ({
      userId,
      workspaces: workspaces.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * Email each digest's owner, at most DIGEST_MAX_EMAILS_PER_RUN per run. The
 * idempotency key `digest/<userId>/<UTC day of now>` makes a re-run of the
 * step (or of the whole run, the same day) send nothing twice. One owner's
 * failed send is logged and the rest still go out.
 */
export async function sendProblemDigests(
  digests: ProblemDigest[],
  now: Date,
): Promise<ProblemDigestSendResult> {
  const batch = digests.slice(0, DIGEST_MAX_EMAILS_PER_RUN);
  const left = digests.length - batch.length;
  if (left > 0) {
    logger.warn("[digest] Daily problems email cap reached; the rest are not sent today", {
      cap: DIGEST_MAX_EMAILS_PER_RUN,
      left,
    });
  }
  if (batch.length === 0) return { sent: 0, failed: 0, left };

  const users = await prisma.user.findMany({
    where: { id: { in: batch.map((digest) => digest.userId) } },
    select: { id: true, email: true },
  });
  const emailOf = new Map(users.map((user) => [user.id, user.email]));
  const day = utcDayKey(now);
  const appBaseUrl = process.env.NEXTAUTH_URL || null;

  let sent = 0;
  let failed = 0;
  for (const digest of batch) {
    const to = emailOf.get(digest.userId);
    if (!to) continue;
    try {
      await sendEmail(
        { to, ...buildProblemDigestEmail({ workspaces: digest.workspaces, appBaseUrl }) },
        { idempotencyKey: `digest/${digest.userId}/${day}` },
      );
      sent++;
    } catch (error) {
      failed++;
      logger.error("[digest] Couldn't send one daily problems email; carrying on", {
        error,
        userId: digest.userId,
      });
    }
  }
  return { sent, failed, left };
}
